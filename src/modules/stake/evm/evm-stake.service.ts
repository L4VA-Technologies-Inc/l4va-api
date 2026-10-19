import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  createPublicClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  isHash,
  parseEventLogs,
  type Address,
  type Hex,
  type Log,
} from 'viem';

import { StakedBalanceRes, StakedBoxItem } from '../dto/staked-balance.res';
import { toHumanAmountString } from '../stake-amounts';

import { ERC20_METADATA_ABI, EVM_STAKING_ABI } from './evm-staking.abi';

import { StakingStatus, TokenStakingPosition, TokenType } from '@/database/tokenStakingPosition.entity';
import { Transaction } from '@/database/transaction.entity';
import { User } from '@/database/user.entity';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';
import { ChainType } from '@/types/vault.types';

/** Marks EVM rows so the Cardano reconciliation crons leave them alone. */
export const EVM_STAKE_CHAIN = ChainType.robinhood;

/**
 * `token_staking_positions.amount` holds Cardano L4VA units (6 decimals) and
 * l4va-rewards sums it across chains, so EVM amounts (18 decimals) are scaled
 * down to the same unit. The exact raw amount stays in the tx metadata.
 */
const DB_L4VA_DECIMALS = 6;

const LOG_CHUNK_BLOCKS = 50_000n;
/** Cap the first-run backfill so a bad deploy block can't trigger a full-chain walk. */
const MAX_LOOKBACK_BLOCKS = 500_000n;

type StakingEventName = 'Staked' | 'Unstaked' | 'Harvested' | 'Compounded' | 'EmergencyUnstaked';

type StakingLog = Log & {
  eventName: StakingEventName;
  args: {
    positionId: bigint;
    owner: Address;
    token?: Address;
    amount?: bigint;
    principal?: bigint;
    reward?: bigint;
    newAmount?: bigint;
  };
};

/**
 * 18-decimal raw amounts exceed Number.MAX_SAFE_INTEGER past ~0.009 tokens,
 * which `toHumanAmountNumber` rejects; go through the exact decimal string.
 */
const toHumanEvmAmount = (raw: bigint, decimals: number): number => Number(toHumanAmountString(raw, decimals));

type TokenInfo = { address: Address; symbol: string; decimals: number; type: TokenType | null };

type OnChainPosition = {
  owner: Address;
  stakedAt: bigint;
  open: boolean;
  token: Address;
  amount: bigint;
  indexAtStake: bigint;
};

export type EvmStakeConfig = {
  configured: boolean;
  chainId: number;
  stakingAddress: string | null;
  maxBatch: number;
  /** Native fee per stake, in wei; the client sends it as msg.value. */
  fees: { recipient: string | null; stakeFee: string };
  tokens: Array<{
    address: string;
    symbol: string;
    type: TokenType | null;
    decimals: number;
    enabled: boolean;
    apy: number;
    minStake: string;
    totalStaked: string;
    rewardReserve: string;
  }>;
};

export type EvmConfirmResult =
  | { success: true; txHash: string; transactionId: string | null; events: number }
  | { success: false; message: string };

/**
 * L4VAStaking on Robinhood Chain — the EVM counterpart of the Cardano staking
 * flow in StakeService.
 *
 * The user's wallet calls the contract directly (rewards are priced on-chain,
 * so no admin co-sign is needed). This service only:
 *   • serves positions with live rewards read from the contract;
 *   • mirrors contract events into `transactions` + `token_staking_positions`
 *     the way StakeService does on Cardano (harvest / compound close the old
 *     row and open a new one), so rewards alignment and admin analytics work
 *     unchanged. Ingestion is idempotent per tx hash: the client reports its
 *     tx via `confirm`, and a cron scans the logs as a backstop.
 *
 * Env:
 *   EVM_STAKING_ADDRESS=0x...
 *   EVM_STAKING_DEPLOY_BLOCK=<block>   (first log scan starts here)
 *   EVM_RPC_URL, EVM_CHAIN_ID (shared)
 */
@Injectable()
export class EvmStakeService implements OnModuleInit {
  private readonly logger = new Logger(EvmStakeService.name);

  private readonly address: Address | null = null;
  private readonly chainId: number;
  private readonly deployBlock: bigint;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly client: any;

  private tokens = new Map<string, TokenInfo>();
  private lastScannedBlock: bigint | null = null;
  private scanning = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>
  ) {
    const rawAddress = this.configService.get<string>('EVM_STAKING_ADDRESS')?.trim();
    const rpcUrl = this.configService.get<string>('EVM_RPC_URL');
    this.chainId = Number(this.configService.get<string>('EVM_CHAIN_ID') || '46630');
    this.deployBlock = BigInt(this.configService.get<string>('EVM_STAKING_DEPLOY_BLOCK')?.trim() || '0');

    if (!rawAddress || !rpcUrl) return;
    if (!isAddress(rawAddress)) {
      this.logger.error(`EVM_STAKING_ADDRESS is not a valid address — EVM staking disabled.`);
      return;
    }

    this.address = getAddress(rawAddress);
    const chain = defineChain({
      id: this.chainId,
      name: 'Robinhood Chain',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    this.client = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 2 }) });
  }

  get configured(): boolean {
    return this.address !== null;
  }

  async onModuleInit(): Promise<void> {
    if (!this.configured) return;
    this.logger.log(`EVM staking on ${this.address}`);
    void this.scanLogs();
  }

  // ---------------------------------------------------------------------------
  // Tokens
  // ---------------------------------------------------------------------------

  private async loadTokens(): Promise<Map<string, TokenInfo>> {
    const listed: Address[] = await this.client.readContract({
      address: this.address,
      abi: EVM_STAKING_ABI,
      functionName: 'listedTokens',
    });

    for (const token of listed) {
      const key = token.toLowerCase();
      if (this.tokens.has(key)) continue;
      const [symbol, decimals] = (await Promise.all([
        this.client.readContract({ address: token, abi: ERC20_METADATA_ABI, functionName: 'symbol' }),
        this.client.readContract({ address: token, abi: ERC20_METADATA_ABI, functionName: 'decimals' }),
      ])) as [string, number];
      const type = Object.values(TokenType).includes(symbol as TokenType) ? (symbol as TokenType) : null;
      this.tokens.set(key, { address: getAddress(token), symbol, decimals: Number(decimals), type });
    }
    return this.tokens;
  }

  private async tokenInfo(token: Address): Promise<TokenInfo | null> {
    const key = token.toLowerCase();
    if (!this.tokens.has(key)) await this.loadTokens();
    return this.tokens.get(key) ?? null;
  }

  private toDbAmount(raw: bigint, decimals: number): number {
    const scaled =
      decimals >= DB_L4VA_DECIMALS
        ? raw / 10n ** BigInt(decimals - DB_L4VA_DECIMALS)
        : raw * 10n ** BigInt(DB_L4VA_DECIMALS - decimals);
    if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('staking position amount exceeds safe range');
    return Number(scaled);
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async getConfig(): Promise<EvmStakeConfig> {
    const empty: EvmStakeConfig = {
      configured: false,
      chainId: this.chainId,
      stakingAddress: null,
      maxBatch: 25,
      fees: { recipient: null, stakeFee: '0' },
      tokens: [],
    };
    if (!this.configured) return empty;

    const tokens = await this.loadTokens();
    const read = (functionName: 'MAX_BATCH' | 'stakeFee' | 'feeRecipient'): Promise<unknown> =>
      this.client.readContract({ address: this.address, abi: EVM_STAKING_ABI, functionName });
    const [maxBatch, stakeFee, feeRecipient] = (await Promise.all([
      read('MAX_BATCH'),
      read('stakeFee'),
      read('feeRecipient'),
    ])) as [bigint, bigint, Address];

    const rows = await Promise.all(
      Array.from(tokens.values()).map(async t => {
        const [cfg, reserve] = await Promise.all([
          this.client.readContract({
            address: this.address,
            abi: EVM_STAKING_ABI,
            functionName: 'tokenConfig',
            args: [t.address],
          }),
          this.client.readContract({
            address: this.address,
            abi: EVM_STAKING_ABI,
            functionName: 'rewardReserve',
            args: [t.address],
          }),
        ]);
        return {
          address: t.address,
          symbol: t.symbol,
          type: t.type,
          decimals: t.decimals,
          enabled: cfg.enabled as boolean,
          apy: Number(cfg.apyBps) / 100,
          minStake: (cfg.minStake as bigint).toString(),
          totalStaked: (cfg.totalStaked as bigint).toString(),
          rewardReserve: (reserve as bigint).toString(),
        };
      })
    );

    return {
      configured: true,
      chainId: this.chainId,
      stakingAddress: this.address,
      maxBatch: Number(maxBatch),
      fees: { recipient: feeRecipient, stakeFee: stakeFee.toString() },
      tokens: rows,
    };
  }

  /** Open positions with live rewards, shaped like the Cardano balance response. */
  async getStakedBalance(userAddress: string): Promise<StakedBalanceRes> {
    if (!this.configured || !isAddress(userAddress)) return { boxes: [], apy: {} };

    const config = await this.getConfig();
    const apyByAddress = new Map(config.tokens.map(t => [t.address.toLowerCase(), t.apy]));
    const apy = Object.fromEntries(config.tokens.filter(t => t.type).map(t => [t.type as string, t.apy]));

    const ids: bigint[] = await this.client.readContract({
      address: this.address,
      abi: EVM_STAKING_ABI,
      functionName: 'positionsOf',
      args: [getAddress(userAddress)],
    });
    if (ids.length === 0) return { boxes: [], apy };

    const positions = (await Promise.all(
      ids.map(id =>
        this.client.readContract({
          address: this.address,
          abi: EVM_STAKING_ABI,
          functionName: 'getPosition',
          args: [id],
        })
      )
    )) as OnChainPosition[];

    const open = ids.map((id, i) => ({ id, p: positions[i] })).filter(x => x.p.open);
    const rewards = (await Promise.all(
      open.map(({ id }) =>
        this.client.readContract({
          address: this.address,
          abi: EVM_STAKING_ABI,
          functionName: 'pendingReward',
          args: [id],
        })
      )
    )) as bigint[];

    const boxes: StakedBoxItem[] = [];
    for (let i = 0; i < open.length; i++) {
      const { id, p } = open[i];
      const token = await this.tokenInfo(p.token);
      const decimals = token?.decimals ?? 18;
      const reward = rewards[i];
      boxes.push({
        positionId: id.toString(),
        txHash: '',
        outputIndex: 0,
        unit: p.token.toLowerCase(),
        policyId: p.token.toLowerCase(),
        stakedAmount: toHumanEvmAmount(p.amount, decimals),
        stakedAt: Number(p.stakedAt) * 1000,
        estimatedReward: toHumanEvmAmount(reward, decimals),
        estimatedPayout: toHumanEvmAmount(p.amount + reward, decimals),
        apy: apyByAddress.get(p.token.toLowerCase()) ?? 0,
        eligible: true,
      });
    }

    return { boxes, apy };
  }

  // ---------------------------------------------------------------------------
  // Ingestion
  // ---------------------------------------------------------------------------

  /** Called by the client right after its wallet tx is mined. */
  async confirmTx(userAddress: string, txHash: string): Promise<EvmConfirmResult> {
    if (!this.configured) return { success: false, message: 'EVM staking is not configured.' };
    if (!isHash(txHash)) return { success: false, message: 'Invalid transaction hash.' };

    try {
      const receipt = await this.client.waitForTransactionReceipt({ hash: txHash as Hex, timeout: 60_000 });
      if (receipt.status !== 'success') return { success: false, message: 'Transaction reverted.' };
      if (receipt.from.toLowerCase() !== userAddress.toLowerCase()) {
        return { success: false, message: 'Transaction was not sent by the authenticated wallet.' };
      }

      const logs = this.parseStakingLogs(receipt.logs);
      if (logs.length === 0) return { success: false, message: 'No staking events in this transaction.' };

      const transactionId = await this.ingestTx(txHash as Hex, logs);
      return { success: true, txHash, transactionId, events: logs.length };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`confirmTx ${txHash} failed: ${message}`);
      return { success: false, message: 'Could not confirm the transaction yet. It will be picked up automatically.' };
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'evm-staking-log-scan' })
  async scanLogs(): Promise<void> {
    if (!this.configured || this.scanning) return;
    this.scanning = true;
    try {
      const head: bigint = await this.client.getBlockNumber();
      let from = this.lastScannedBlock !== null ? this.lastScannedBlock + 1n : this.deployBlock;
      if (head - from > MAX_LOOKBACK_BLOCKS) from = head - MAX_LOOKBACK_BLOCKS;

      while (from <= head) {
        const to = from + LOG_CHUNK_BLOCKS - 1n < head ? from + LOG_CHUNK_BLOCKS - 1n : head;
        const raw: Log[] = await this.client.getLogs({ address: this.address, fromBlock: from, toBlock: to });
        const byTx = new Map<Hex, StakingLog[]>();
        for (const log of this.parseStakingLogs(raw)) {
          const list = byTx.get(log.transactionHash as Hex) ?? [];
          list.push(log);
          byTx.set(log.transactionHash as Hex, list);
        }
        for (const [hash, logs] of byTx) {
          await this.ingestTx(hash, logs).catch(err =>
            this.logger.error(`EVM staking ingest ${hash} failed: ${(err as Error).message}`)
          );
        }
        this.lastScannedBlock = to;
        from = to + 1n;
      }
    } catch (err) {
      this.logger.error(`EVM staking log scan failed: ${(err as Error).message}`);
    } finally {
      this.scanning = false;
    }
  }

  private parseStakingLogs(logs: Log[]): StakingLog[] {
    const own = logs.filter(l => l.address.toLowerCase() === this.address!.toLowerCase());
    return parseEventLogs({ abi: EVM_STAKING_ABI, logs: own }) as unknown as StakingLog[];
  }

  private txTypeFor(logs: StakingLog[]): TransactionType {
    switch (logs[0].eventName) {
      case 'Staked':
        return TransactionType.stake;
      case 'Harvested':
        return TransactionType.harvest;
      case 'Compounded':
        return TransactionType.compound;
      default:
        return TransactionType.unstake;
    }
  }

  /**
   * Mirrors one contract tx into the DB. One `transactions` row per tx hash
   * (a batch unstake emits several events); a second call for the same hash
   * is a no-op. Returns the transaction id, or null when the owner has no
   * account here.
   */
  private async ingestTx(txHash: Hex, logs: StakingLog[]): Promise<string | null> {
    const existing = await this.transactionRepository.findOne({ where: { tx_hash: txHash }, select: ['id'] });
    if (existing) return existing.id;

    const owner = logs[0].args.owner;
    const user = await this.userRepository
      .createQueryBuilder('u')
      .where('LOWER(u.address) = LOWER(:address)', { address: owner })
      .andWhere('u.chain_type = :chain', { chain: ChainType.robinhood })
      .getOne();
    if (!user) {
      this.logger.warn(`EVM staking tx ${txHash}: no robinhood user for ${owner}, skipped`);
      return null;
    }

    const block = await this.client.getBlock({ blockNumber: logs[0].blockNumber });
    const stakedAtMs = Number(block.timestamp) * 1000;
    const type = this.txTypeFor(logs);

    const tokenEntries = await Promise.all(
      logs.map(async log => {
        const position = log.args.token
          ? { token: log.args.token }
          : ((await this.client.readContract({
              address: this.address,
              abi: EVM_STAKING_ABI,
              functionName: 'getPosition',
              args: [log.args.positionId],
            })) as OnChainPosition);
        return { log, token: await this.tokenInfo(position.token) };
      })
    );

    return this.dataSource.transaction(async manager => {
      const txRepo = manager.getRepository(Transaction);
      const posRepo = manager.getRepository(TokenStakingPosition);

      // Re-check inside the db transaction: confirm and the cron can race.
      const raced = await txRepo.findOne({ where: { tx_hash: txHash }, select: ['id'] });
      if (raced) return raced.id;

      const saved = await txRepo.save({
        type,
        status: TransactionStatus.confirmed,
        user_id: user.id,
        tx_hash: txHash,
        utxo_input: type === TransactionType.stake ? owner : this.address!,
        utxo_output: type === TransactionType.stake || type === TransactionType.compound ? this.address! : owner,
        amount: 0,
        metadata: {
          chain: EVM_STAKE_CHAIN,
          chainId: this.chainId,
          contractAddress: this.address,
          blockNumber: logs[0].blockNumber?.toString(),
          staked_at: type === TransactionType.unstake ? undefined : stakedAtMs,
          events: tokenEntries.map(({ log, token }) => ({
            event: log.eventName,
            positionId: log.args.positionId.toString(),
            token: token?.address ?? null,
            tokenType: token?.type ?? null,
            decimals: token?.decimals ?? null,
            amount: log.args.amount?.toString(),
            principal: log.args.principal?.toString(),
            reward: log.args.reward?.toString(),
            newAmount: log.args.newAmount?.toString(),
          })),
        },
      });

      for (const { log, token } of tokenEntries) {
        // Scoped by contract: ids restart at 1 on every L4VAStaking deployment.
        const positionId = `${this.address!.toLowerCase()}:${log.args.positionId}`;
        if (!token?.type) {
          this.logger.warn(`EVM staking tx ${txHash}: unknown token for position ${positionId}`);
          continue;
        }

        const active = await posRepo.findOne({
          where: { chain_position_id: positionId, status: StakingStatus.ACTIVE },
        });

        if (log.eventName === 'Staked') {
          await posRepo.save({
            user_id: user.id,
            token_type: token.type,
            amount: this.toDbAmount(log.args.amount!, token.decimals),
            status: StakingStatus.ACTIVE,
            stake_tx_id: saved.id,
            chain_position_id: positionId,
          });
          continue;
        }

        if (active) {
          await posRepo.save({ ...active, status: StakingStatus.CLOSED, unstake_tx_id: saved.id });
        } else {
          this.logger.warn(`EVM staking tx ${txHash}: no ACTIVE row for position ${positionId}`);
        }

        // Harvest / compound keep the position open on-chain with a fresh
        // timer; mirror Cardano by opening a new row for the re-locked amount.
        // Harvest leaves the deposit unchanged, so the closed row's amount carries over.
        if (log.eventName === 'Harvested' || log.eventName === 'Compounded') {
          let amount: number;
          if (log.eventName === 'Compounded') {
            amount = this.toDbAmount(log.args.newAmount!, token.decimals);
          } else if (active) {
            amount = Number(active.amount);
          } else {
            const onChain = (await this.client.readContract({
              address: this.address,
              abi: EVM_STAKING_ABI,
              functionName: 'getPosition',
              args: [log.args.positionId],
            })) as OnChainPosition;
            amount = this.toDbAmount(onChain.amount, token.decimals);
          }
          await posRepo.save({
            user_id: user.id,
            token_type: token.type,
            amount,
            status: StakingStatus.ACTIVE,
            stake_tx_id: saved.id,
            chain_position_id: positionId,
          });
        }
      }

      this.logger.log(`EVM staking ${type} ${txHash} ingested for user ${user.id} (${logs.length} event(s))`);
      return saved.id;
    });
  }
}
