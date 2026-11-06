import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { erc20Abi, parseAbiItem, type Address } from 'viem';

import { EvmContractReader } from '../../processing-tx/onchain/evm-contract-reader.service';
import { VAULT_ABI } from '../../processing-tx/onchain/vault.abi';

import { EvmLpVotingService } from './evm-lp-voting.service';

import { Snapshot } from '@/database/snapshot.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { resolveVaultDeployBlock } from '@/modules/vaults/processing-tx/onchain/evm-protocol-versions';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';
import { ChainType, VaultStatus } from '@/types/vault.types';

const ERC20_TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/** Just the checkpoint readers — the full VaultToken ABI is not needed here. */
const VAULT_TOKEN_CHECKPOINT_ABI = [
  parseAbiItem('function balanceOfAt(address account, uint256 timepoint) view returns (uint256)'),
  parseAbiItem('function circulatingSupplyAt(uint256 timepoint) view returns (uint256)'),
  parseAbiItem('function isExcludedHolderAt(address account, uint256 timepoint) view returns (bool)'),
] as const;

const VAULT_TOKEN_EXCLUSION_ABI = [
  parseAbiItem('function isExcludedHolder(address account) view returns (bool)'),
] as const;

export { VAULT_TOKEN_CHECKPOINT_ABI };

/** Block range per getLogs request — stays safely within most RPC limits. */
const LOG_CHUNK_BLOCKS = 10_000n;
const VAULT_TOKEN_SUPPLY_ABI = [
  parseAbiItem('function excludedSupplyAt(uint256 timepoint) view returns (uint256)'),
] as const;
const HOLDERS_API_PAGE_SIZE = 200;
const ALCHEMY_BALANCE_BATCH_SIZE = 20;
const DEFAULT_MAX_FULL_REPLAY_CHUNKS = 400;

@Injectable()
export class EvmSnapshotService {
  private readonly logger = new Logger(EvmSnapshotService.name);

  constructor(
    @InjectRepository(Vault) private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Snapshot) private readonly snapshotRepository: Repository<Snapshot>,
    private readonly contractReader: EvmContractReader,
    private readonly configService: ConfigService,
    private readonly lpVoting: EvmLpVotingService
  ) {}

  /**
   * Scan all ERC-20 Transfer events on the vault's VaultToken contract,
   * build a current holder→balance map, and persist it as a Snapshot.
   *
   * The address map mirrors the Cardano snapshot format so all downstream
   * voting-power logic works without changes.
   *
   * Called by createDailySnapshots for EVM vaults and by createProposal
   * when no recent snapshot exists.
   */
  async createSnapshot(vaultId: string): Promise<Snapshot> {
    const startedAt = Date.now();
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      select: ['id', 'contract_address', 'chain_type'],
    });

    if (!vault || vault.chain_type !== ChainType.robinhood) {
      throw new Error(`Vault ${vaultId} is not an EVM vault`);
    }
    if (!vault.contract_address) {
      throw new Error(`Vault ${vaultId} has no contract address`);
    }

    const vtAddress = await this.getVaultTokenAddress(vault.contract_address as Address);

    // Pin the chain position BEFORE reading balances. The holder sources below
    // all read chain head, so capturing the block first means the recorded
    // timepoint can only be at or behind the data, never ahead of it — an
    // ahead-of-data timepoint would attribute balances to a moment they did
    // not exist at. Any drift is caught by `reconcileWithChain` before a
    // distribution is opened against this snapshot.
    const pinnedBlock = await this.contractReader.publicClient.getBlock();
    this.logger.debug(`[EVM Snapshot] Vault ${vaultId}: resolved vaultToken=${vtAddress}`);
    const latestSnapshot = await this.snapshotRepository.findOne({
      where: { vaultId },
      order: { createdAt: 'DESC' },
      select: ['id', 'assetId', 'addressBalances', 'createdAt', 'snapshotBlock'],
    });

    const canUseIncrementalBaseline =
      !!latestSnapshot && latestSnapshot.assetId?.toLowerCase() === vtAddress.toLowerCase();

    if (canUseIncrementalBaseline) {
      this.logger.debug(
        `[EVM Snapshot] Vault ${vaultId}: using incremental baseline snapshot=${latestSnapshot.id} createdAt=${latestSnapshot.createdAt.toISOString()}`
      );
    } else if (latestSnapshot) {
      this.logger.warn(
        `[EVM Snapshot] Vault ${vaultId}: latest snapshot assetId (${latestSnapshot.assetId}) does not match current vtToken (${vtAddress}). Falling back to full rebuild.`
      );
    }

    let balances: Map<string, bigint>;
    let balanceSource: 'holders_api' | 'alchemy_token_balances' | 'transfer_replay';

    try {
      balances = await this.fetchHolderBalancesFromApi(vtAddress, vaultId);
      balanceSource = 'holders_api';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[EVM Snapshot] Vault ${vaultId}: holders API failed (${message}). Falling back to transfer replay.`
      );

      // Transfer replay first: it discovers holders from Transfer events, so it picks up new
      // holders (airdrop claimers, Uniswap buyers). The Alchemy path only re-reads balances of
      // addresses already in the baseline, so it is a last resort when the replay itself fails.
      try {
        balances = await this.buildHolderBalances(
          vtAddress,
          vaultId,
          canUseIncrementalBaseline ? latestSnapshot : null,
          pinnedBlock.number
        );
        balanceSource = 'transfer_replay';
      } catch (replayError) {
        const replayMessage = replayError instanceof Error ? replayError.message : String(replayError);
        const canTryAlchemy =
          this.hasAlchemyApiKey() &&
          canUseIncrementalBaseline &&
          !!latestSnapshot?.addressBalances &&
          Object.keys(latestSnapshot.addressBalances).length > 0;
        if (!canTryAlchemy) throw replayError;

        this.logger.warn(
          `[EVM Snapshot] Vault ${vaultId}: transfer replay failed (${replayMessage}). ` +
            'Falling back to Alchemy balances of baseline holders — new holders will be missed.'
        );
        balances = await this.fetchHolderBalancesFromAlchemy(vtAddress, vaultId, latestSnapshot!);
        balanceSource = 'alchemy_token_balances';
      }
    }

    await this.dropNonVoters(balances, vault.contract_address as Address, vtAddress, vaultId);

    // A baseline-derived snapshot inherits any holder the baseline missed, and every later snapshot
    // inherits it again. Self-check against the token: if the voters' balances do not add up to
    // the voting supply at the pinned block, rebuild this snapshot from the token's deployment.
    if (balanceSource !== 'holders_api' && canUseIncrementalBaseline) {
      const expected = await this.votingSupplyAt(vtAddress, vault.contract_address as Address, pinnedBlock);
      const tracked = [...balances.values()].reduce((sum, value) => sum + value, 0n);
      if (expected !== null && tracked !== expected) {
        this.logger.warn(
          `[EVM Snapshot] Vault ${vaultId}: incremental balances ${tracked} != voting supply ${expected}; rebuilding from scratch`
        );
        balances = await this.buildHolderBalances(vtAddress, vaultId, null, pinnedBlock.number);
        balanceSource = 'transfer_replay';
        await this.dropNonVoters(balances, vault.contract_address as Address, vtAddress, vaultId);
      }
    }

    // Serialize bigint → string to match the Snapshot.addressBalances schema.
    const addressBalancesForSnapshot: Record<string, string> = {};
    for (const [address, balance] of balances.entries()) {
      addressBalancesForSnapshot[address] = String(balance);
    }

    const lpBalances = await this.attributeLpVt(
      vaultId,
      vault.contract_address as Address,
      vtAddress,
      pinnedBlock.number
    );

    const snapshot = this.snapshotRepository.create({
      vaultId,
      // Use the VaultToken ERC-20 address as assetId (mirrors Cardano policy+name pattern).
      assetId: vtAddress.toLowerCase(),
      addressBalances: addressBalancesForSnapshot,
      lpBalances,
      snapshotBlock: String(pinnedBlock.number),
      snapshotTimepoint: String(pinnedBlock.timestamp),
    });

    await this.snapshotRepository.save(snapshot);

    const durationMs = Date.now() - startedAt;
    this.logger.log(
      `EVM snapshot created for vault ${vaultId} — vtToken=${vtAddress} holders=${balances.size} source=${balanceSource} durationMs=${durationMs}`
    );
    return snapshot;
  }

  /**
   * Check a sample of this snapshot's balances against the VaultToken's own
   * checkpoints at the recorded timepoint.
   *
   * Votes are counted from `addressBalances`; a distribution pays from
   * `balanceOfAt`. Those are two different reads of the same thing, and if they
   * disagree the money does not follow the weights the vote was decided on.
   * This is the guard that turns that from a silent divergence into a loud
   * failure before any pot is reserved.
   *
   * Returns the mismatches found; an empty array means the sample agreed.
   */
  async reconcileWithChain(
    snapshot: Snapshot,
    sampleSize = 25
  ): Promise<Array<{ address: string; snapshotBalance: string; chainBalance: string }>> {
    if (!snapshot.snapshotTimepoint) {
      throw new Error(
        `Snapshot ${snapshot.id} has no chain timepoint — it predates timepoint recording and cannot back a distribution. Take a fresh snapshot.`
      );
    }

    const timepoint = BigInt(snapshot.snapshotTimepoint);
    const entries = Object.entries(snapshot.addressBalances ?? {});
    if (entries.length === 0) return [];

    // Largest holders first: a divergence there moves the most money.
    const sample = entries.sort(([, a], [, b]) => (BigInt(b) > BigInt(a) ? 1 : -1)).slice(0, sampleSize);

    const mismatches: Array<{ address: string; snapshotBalance: string; chainBalance: string }> = [];
    for (const [address, snapshotBalance] of sample) {
      const chainBalance = (await this.contractReader.publicClient.readContract({
        address: snapshot.assetId as Address,
        abi: VAULT_TOKEN_CHECKPOINT_ABI,
        functionName: 'balanceOfAt',
        args: [address as Address, timepoint],
      })) as bigint;

      if (String(chainBalance) !== snapshotBalance) {
        mismatches.push({ address, snapshotBalance, chainBalance: String(chainBalance) });
      }
    }

    if (mismatches.length > 0) {
      this.logger.error(
        `[EVM Snapshot] Vault ${snapshot.vaultId}: snapshot ${snapshot.id} disagrees with on-chain balanceOfAt at ` +
          `timepoint ${timepoint} for ${mismatches.length}/${sample.length} sampled holders.`
      );
    }
    return mismatches;
  }

  /** Return all EVM vaults currently in locked/expansion status. */
  async findEligibleVaults(): Promise<Pick<Vault, 'id' | 'contract_address'>[]> {
    return this.vaultRepository.find({
      where: [
        { chain_type: ChainType.robinhood, vault_status: VaultStatus.locked },
        { chain_type: ChainType.robinhood, vault_status: VaultStatus.expansion },
        { chain_type: ChainType.robinhood, vault_status: VaultStatus.acquire_expansion },
      ],
      select: ['id', 'contract_address'],
    });
  }

  // ---------------------------------------------------------------------------

  /**
   * Remove holders that must not vote: the vault itself (unclaimed / LP-reserved VT)
   * and every address the VaultToken marks as excluded (the Uniswap v4 PoolManager
   * holding LP VT). Left in, the PoolManager alone outweighs all holders of a small vault.
   */
  /**
   * VT that can vote at `block`: total supply minus excluded holders (pools etc.) minus what the
   * vault itself holds. Null when the token predates `excludedSupplyAt`, so the check is skipped.
   */
  private async votingSupplyAt(
    vtAddress: Address,
    vaultAddress: Address,
    block: { number: bigint; timestamp: bigint }
  ): Promise<bigint | null> {
    try {
      const client = this.contractReader.publicClient;
      const at = { blockNumber: block.number };
      // Checkpoints only answer for a past timepoint, so read one second before the pinned block.
      const timepoint = block.timestamp - 1n;
      const [supply, excluded, vaultBalance, vaultExcluded] = await Promise.all([
        client.readContract({ address: vtAddress, abi: erc20Abi, functionName: 'totalSupply', ...at }),
        client.readContract({
          address: vtAddress,
          abi: VAULT_TOKEN_SUPPLY_ABI,
          functionName: 'excludedSupplyAt',
          args: [timepoint],
          ...at,
        }),
        client.readContract({
          address: vtAddress,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [vaultAddress],
          ...at,
        }),
        client.readContract({
          address: vtAddress,
          abi: VAULT_TOKEN_EXCLUSION_ABI,
          functionName: 'isExcludedHolder',
          args: [vaultAddress],
          ...at,
        }),
      ]);
      return (supply as bigint) - (excluded as bigint) - (vaultExcluded ? 0n : (vaultBalance as bigint));
    } catch {
      return null;
    }
  }

  private async dropNonVoters(
    balances: Map<string, bigint>,
    vaultAddress: Address,
    vtAddress: Address,
    vaultId: string
  ): Promise<void> {
    balances.delete(vaultAddress.toLowerCase());
    balances.delete('0x0000000000000000000000000000000000000000');
    // The v4 PoolManager holds the VT of every v4 pool. Drop it even when the VaultToken never
    // excluded it (no LP of ours): its VT is attributed to position owners, so keeping it would
    // double-count, and as a contract it could never claim a distribution share.
    const poolManager = await this.lpVoting.poolManagerAddress(vaultId).catch(() => null);
    if (poolManager) balances.delete(poolManager.toLowerCase());

    const holders = [...balances.keys()];
    const excluded: string[] = [];
    for (let i = 0; i < holders.length; i += ALCHEMY_BALANCE_BATCH_SIZE) {
      const batch = holders.slice(i, i + ALCHEMY_BALANCE_BATCH_SIZE);
      const flags = await Promise.all(
        batch.map(
          holder =>
            this.contractReader.publicClient.readContract({
              address: vtAddress,
              abi: VAULT_TOKEN_EXCLUSION_ABI,
              functionName: 'isExcludedHolder',
              args: [holder as Address],
            }) as Promise<boolean>
        )
      );
      batch.forEach((holder, idx) => flags[idx] && excluded.push(holder));
    }

    for (const holder of excluded) balances.delete(holder);
    if (excluded.length > 0) {
      this.logger.debug(`[EVM Snapshot] Vault ${vaultId}: excluded non-voting holders ${excluded.join(', ')}`);
    }
  }

  /**
   * Voting weight for VT that holders put into Uniswap pools. A failure here leaves LP
   * providers without a vote on this snapshot rather than blocking the proposal.
   */
  private async attributeLpVt(
    vaultId: string,
    vaultAddress: Address,
    vtAddress: Address,
    atBlock: bigint
  ): Promise<Record<string, string> | null> {
    try {
      const fromBlock = (await this.vaultCreationBlock(vaultId)) ?? (await this.factoryDeployBlock(vaultId));
      const lp = await this.lpVoting.attributeLpVt(vaultId, vaultAddress, vtAddress, fromBlock, atBlock);
      if (lp.size === 0) return null;
      return Object.fromEntries([...lp.entries()].map(([address, vt]) => [address, String(vt)]));
    } catch (error) {
      this.logger.error(
        `[EVM Snapshot] Vault ${vaultId}: LP voting attribution failed, LP providers get no vote on this snapshot — ${(error as Error).message}`
      );
      return null;
    }
  }

  private async getVaultTokenAddress(vaultAddress: Address): Promise<Address> {
    return this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'vaultToken',
    }) as Promise<Address>;
  }

  /**
   * Reconstruct current ERC-20 balances by replaying all Transfer events.
   * Chunks getLogs by block range to stay within RPC limits.
   */
  private async buildHolderBalances(
    vtAddress: Address,
    vaultId: string,
    baselineSnapshot?: Snapshot | null,
    toBlock?: bigint
  ): Promise<Map<string, bigint>> {
    const balances = baselineSnapshot
      ? this.snapshotAddressBalancesToMap(baselineSnapshot.addressBalances)
      : new Map<string, bigint>();

    // Replay up to the snapshot's pinned block so its balances match `snapshotBlock` exactly and the
    // next incremental replay (which starts at snapshotBlock + 1) neither skips nor repeats transfers.
    const latestBlock: bigint = toBlock ?? (await this.contractReader.publicClient.getBlockNumber());
    const startedAt = Date.now();
    let chunkIndex = 0;
    let totalLogs = 0;

    let fromBlock: bigint;

    if (baselineSnapshot) {
      // Resume right after the block the baseline was read at. `createdAt` is the save time, which
      // can land after transfers that happened while the snapshot was being built (e.g. the claims
      // minted at lock); estimating from it skipped those transfers in every later snapshot.
      const baselineBlock = baselineSnapshot.snapshotBlock
        ? BigInt(baselineSnapshot.snapshotBlock)
        : await this.estimateBlockForTimestamp(baselineSnapshot.createdAt, latestBlock);
      fromBlock = baselineBlock + 1n;
      this.logger.debug(
        `[EVM Snapshot] Vault ${vaultId}: incremental replay from block ${fromBlock.toString()} (latest=${latestBlock.toString()})`
      );
    } else {
      try {
        fromBlock = await this.findContractDeploymentBlock(vaultId, vtAddress, latestBlock);
      } catch (error) {
        if (this.isMissingTrieNodeError(error)) {
          // Non-archive RPCs may fail historical eth_getCode lookups. The VT is
          // created in the vault's createVault tx, whose receipt any RPC serves;
          // replaying from the factory deploy block instead blows the chunk limit.
          const creationBlock = await this.vaultCreationBlock(vaultId);
          fromBlock = creationBlock ?? (await this.factoryDeployBlock(vaultId));
          this.logger.warn(
            `[EVM Snapshot] Vault ${vaultId}: deployment block lookup failed on non-archive RPC; falling back to replay from ${creationBlock !== null ? 'createVault' : 'factory deploy'} block ${fromBlock.toString()}`
          );
        } else {
          throw error;
        }
      }
      this.logger.debug(
        `[EVM Snapshot] Vault ${vaultId}: full replay from deployment block ${fromBlock.toString()} (latest=${latestBlock.toString()})`
      );
    }

    if (fromBlock > latestBlock) {
      this.logger.debug(
        `[EVM Snapshot] Vault ${vaultId}: no new blocks to replay (fromBlock=${fromBlock.toString()}, latest=${latestBlock.toString()})`
      );
      return balances;
    }

    const startBlock = fromBlock;
    const scanRange = latestBlock - startBlock + 1n;

    const estimatedChunks = Number((scanRange + LOG_CHUNK_BLOCKS - 1n) / LOG_CHUNK_BLOCKS);

    if (!baselineSnapshot) {
      const maxFullReplayChunks = this.resolveMaxFullReplayChunks();
      if (estimatedChunks > maxFullReplayChunks) {
        throw new Error(
          `Full replay aborted: estimatedChunks=${estimatedChunks} exceeds limit=${maxFullReplayChunks}. Configure ROBINHOOD_HOLDERS_API_BASE_URL to a working explorer endpoint or increase EVM_SNAPSHOT_MAX_FULL_REPLAY_CHUNKS if full replay is intentional.`
        );
      }
    }

    this.logger.debug(
      `[EVM Snapshot] Vault ${vaultId}: replay start vtToken=${vtAddress} fromBlock=${startBlock.toString()} latestBlock=${latestBlock.toString()} chunkSize=${LOG_CHUNK_BLOCKS.toString()} estimatedChunks=${estimatedChunks}`
    );

    while (fromBlock <= latestBlock) {
      const toBlock = fromBlock + LOG_CHUNK_BLOCKS - 1n < latestBlock ? fromBlock + LOG_CHUNK_BLOCKS - 1n : latestBlock;
      chunkIndex++;

      const logs = await this.contractReader.publicClient.getLogs({
        address: vtAddress,
        event: ERC20_TRANSFER_EVENT,
        fromBlock,
        toBlock,
      });
      totalLogs += logs.length;

      if (chunkIndex === 1 || chunkIndex % 25 === 0 || toBlock === latestBlock) {
        const elapsedMs = Date.now() - startedAt;
        const scannedRange = toBlock - startBlock + 1n;
        const progressPercent = scanRange === 0n ? 100 : Number((scannedRange * 100n) / scanRange);
        this.logger.debug(
          `[EVM Snapshot] Vault ${vaultId}: replay progress chunk=${chunkIndex}/${estimatedChunks} blocks=${fromBlock.toString()}-${toBlock.toString()} logsInChunk=${logs.length} totalLogs=${totalLogs} progress=${progressPercent}% elapsedMs=${elapsedMs}`
        );
      }

      for (const log of logs) {
        const { from, to, value } = log.args as { from: Address; to: Address; value: bigint };

        // Burn (to = 0x0): subtract from sender.
        const toNorm = to.toLowerCase();
        const fromNorm = from.toLowerCase();
        const ZERO = '0x0000000000000000000000000000000000000000';

        if (fromNorm !== ZERO) {
          balances.set(fromNorm, (balances.get(fromNorm) ?? 0n) - value);
        }
        if (toNorm !== ZERO) {
          balances.set(toNorm, (balances.get(toNorm) ?? 0n) + value);
        }
      }

      fromBlock = toBlock + 1n;
    }

    // Remove zero/negative balances (shouldn't happen in a correct ERC-20, but be defensive).
    for (const [addr, bal] of balances.entries()) {
      if (bal <= 0n) balances.delete(addr);
    }

    const elapsedMs = Date.now() - startedAt;
    this.logger.debug(
      `[EVM Snapshot] Vault ${vaultId}: replay completed chunks=${chunkIndex} totalLogs=${totalLogs} holders=${balances.size} elapsedMs=${elapsedMs}`
    );

    return balances;
  }

  private snapshotAddressBalancesToMap(
    addressBalances: Record<string, string> | null | undefined
  ): Map<string, bigint> {
    const map = new Map<string, bigint>();

    if (!addressBalances) {
      return map;
    }

    for (const [address, rawBalance] of Object.entries(addressBalances)) {
      try {
        const normalizedAddress = address.toLowerCase();
        const parsed = BigInt(rawBalance);
        if (parsed > 0n) {
          map.set(normalizedAddress, parsed);
        }
      } catch {
        // Ignore malformed historical balances instead of failing the snapshot job.
      }
    }

    return map;
  }

  /**
   * Primary fast path: fetch token holders from Blockscout v2 API with pagination.
   * Falls back to transfer-replay path when this API is unavailable.
   */
  private async fetchHolderBalancesFromApi(vtAddress: Address, vaultId: string): Promise<Map<string, bigint>> {
    const baseUrls = this.resolveHoldersApiBaseUrls();
    const token = vtAddress.toLowerCase();
    const errors: string[] = [];

    for (const baseUrl of baseUrls) {
      try {
        return await this.fetchHolderBalancesFromApiBase(baseUrl, token, vaultId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${baseUrl}: ${message}`);
        this.logger.warn(`[EVM Snapshot] Vault ${vaultId}: holders API base failed (${baseUrl}) -> ${message}`);
      }
    }

    throw new Error(`All holders API bases failed: ${errors.join(' | ')}`);
  }

  private resolveHoldersApiBaseUrls(): string[] {
    const explicit = this.configService.get<string>('ROBINHOOD_HOLDERS_API_BASE_URL')?.trim();
    if (explicit) {
      return [explicit.replace(/\/$/, '')];
    }

    const testnetBase = 'https://explorer.testnet.chain.robinhood.com/api/v2';
    const mainnetBase = 'https://robinhoodchain.blockscout.com/api/v2';
    const rpcUrl = this.configService.get<string>('ROBINHOOD_RPC_URL', '').toLowerCase();

    if (rpcUrl.includes('testnet')) {
      return [testnetBase, mainnetBase];
    }

    // The Blockscout PRO API key only works on api.blockscout.com/<chainId>; the explorer
    // domain sits behind a Cloudflare challenge that rejects server requests (403).
    const proBase = this.configService.get<string>('BLOCKSCOUT_API_KEY')?.trim()
      ? ['https://api.blockscout.com/4663/api/v2']
      : [];
    return [...proBase, mainnetBase, testnetBase];
  }

  private async fetchHolderBalancesFromApiBase(
    baseUrl: string,
    tokenAddressLower: string,
    vaultId: string
  ): Promise<Map<string, bigint>> {
    const balances = new Map<string, bigint>();

    let pageCount = 0;
    let nextPageParams: Record<string, unknown> | null = null;
    let firstPageVariant: 'none' | 'items_count' | 'page_size' | 'limit' | null = null;

    this.logger.debug(`[EVM Snapshot] Vault ${vaultId}: holders API start base=${baseUrl} token=${tokenAddressLower}`);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      pageCount++;
      const basePath = `${baseUrl}/tokens/${tokenAddressLower}/holders`;
      const variants: Array<'none' | 'items_count' | 'page_size' | 'limit'> =
        pageCount === 1
          ? ['none', 'items_count', 'page_size', 'limit']
          : firstPageVariant
            ? [firstPageVariant]
            : ['none'];

      let data: unknown | null = null;
      let variantError: string | null = null;

      for (const variant of variants) {
        const url = new URL(basePath);

        if (variant === 'items_count') {
          url.searchParams.set('items_count', String(HOLDERS_API_PAGE_SIZE));
        } else if (variant === 'page_size') {
          url.searchParams.set('page_size', String(HOLDERS_API_PAGE_SIZE));
        } else if (variant === 'limit') {
          url.searchParams.set('limit', String(HOLDERS_API_PAGE_SIZE));
        }

        if (nextPageParams) {
          for (const [key, value] of Object.entries(nextPageParams)) {
            if (value == null) continue;
            url.searchParams.set(key, String(value));
          }
        }

        // Only api.blockscout.com accepts the PRO key; the explorer domain answers 403 regardless.
        const blockscoutApiKey = this.configService.get<string>('BLOCKSCOUT_API_KEY')?.trim();
        if (blockscoutApiKey && url.hostname === 'api.blockscout.com') url.searchParams.set('apikey', blockscoutApiKey);

        const response = await fetch(url.toString(), {
          method: 'GET',
          headers: { accept: 'application/json' },
        });

        if (!response.ok) {
          const bodyText = await response.text();
          variantError = `holders API HTTP ${response.status}${bodyText ? ` body=${bodyText.slice(0, 240)}` : ''}`;
          continue;
        }

        data = await response.json();
        if (pageCount === 1) {
          firstPageVariant = variant;
          this.logger.debug(
            `[EVM Snapshot] Vault ${vaultId}: holders API accepted query variant=${variant} base=${baseUrl}`
          );
        }
        break;
      }

      if (data == null) {
        throw new Error(variantError ?? 'holders API request failed');
      }

      const items = this.extractHoldersItems(data);

      for (const item of items) {
        const address = this.extractHolderAddress(item);
        const rawBalance = this.extractHolderBalance(item);

        if (!address || rawBalance == null) {
          continue;
        }

        let balance: bigint;
        try {
          balance = BigInt(rawBalance);
        } catch {
          continue;
        }

        if (balance <= 0n) {
          continue;
        }

        balances.set(address.toLowerCase(), balance);
      }

      const candidate = this.extractNextPageParams(data);
      const hasMore = !!candidate && Object.keys(candidate).length > 0;
      if (!hasMore) {
        break;
      }

      nextPageParams = candidate;
    }

    // this.logger.debug(
    //   `[EVM Snapshot] Vault ${vaultId}: holders API completed base=${baseUrl} pages=${pageCount} rows=${totalRows} uniqueHolders=${balances.size}`
    // );

    return balances;
  }

  private resolveMaxFullReplayChunks(): number {
    const raw = this.configService.get<string>('EVM_SNAPSHOT_MAX_FULL_REPLAY_CHUNKS')?.trim();
    if (!raw) {
      return DEFAULT_MAX_FULL_REPLAY_CHUNKS;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      this.logger.warn(
        `[EVM Snapshot] Invalid EVM_SNAPSHOT_MAX_FULL_REPLAY_CHUNKS value (${raw}); using default ${DEFAULT_MAX_FULL_REPLAY_CHUNKS}`
      );
      return DEFAULT_MAX_FULL_REPLAY_CHUNKS;
    }

    return Math.floor(parsed);
  }

  private hasAlchemyApiKey(): boolean {
    return !!this.configService.get<string>('ALCHEMY_API_KEY')?.trim();
  }

  private resolveAlchemyRpcUrl(): string {
    const apiKey = this.configService.get<string>('ALCHEMY_API_KEY')?.trim();
    if (!apiKey) {
      throw new Error('ALCHEMY_API_KEY is not configured');
    }

    const explicit = this.configService.get<string>('ROBINHOOD_ALCHEMY_RPC_URL')?.trim();
    if (explicit) {
      return explicit.replace(/\/$/, '');
    }

    const network = this.configService.get<string>('ALCHEMY_NETWORK')?.trim().toLowerCase();
    if (network) {
      return `https://${network}.g.alchemy.com/v2/${apiKey}`;
    }

    // Fall back to inferring network from the RPC URL when ALCHEMY_NETWORK is not set.
    const rpcUrl = this.configService.get<string>('ROBINHOOD_RPC_URL', '').toLowerCase();
    if (rpcUrl.includes('testnet')) {
      return `https://robinhood-testnet.g.alchemy.com/v2/${apiKey}`;
    }

    return `https://robinhood-mainnet.g.alchemy.com/v2/${apiKey}`;
  }

  private async fetchHolderBalancesFromAlchemy(
    vtAddress: Address,
    vaultId: string,
    baselineSnapshot: Snapshot
  ): Promise<Map<string, bigint>> {
    const rpcUrl = this.resolveAlchemyRpcUrl();
    const baselineMap = this.snapshotAddressBalancesToMap(baselineSnapshot.addressBalances);
    const addresses = [...baselineMap.keys()];

    if (addresses.length === 0) {
      throw new Error('Baseline snapshot has no holder addresses for Alchemy refresh');
    }

    this.logger.debug(
      `[EVM Snapshot] Vault ${vaultId}: Alchemy fallback start token=${vtAddress.toLowerCase()} baselineHolders=${addresses.length}`
    );

    const balances = new Map<string, bigint>();
    let processed = 0;

    for (let i = 0; i < addresses.length; i += ALCHEMY_BALANCE_BATCH_SIZE) {
      const batch = addresses.slice(i, i + ALCHEMY_BALANCE_BATCH_SIZE);

      const batchResults = await Promise.all(
        batch.map(async address => {
          const balance = await this.fetchAddressTokenBalanceFromAlchemy(rpcUrl, address, vtAddress);
          return { address, balance };
        })
      );

      for (const result of batchResults) {
        processed++;
        if (result.balance > 0n) {
          balances.set(result.address.toLowerCase(), result.balance);
        }
      }

      if (processed === addresses.length || processed % 200 === 0) {
        this.logger.debug(
          `[EVM Snapshot] Vault ${vaultId}: Alchemy fallback progress processed=${processed}/${addresses.length} nonZero=${balances.size}`
        );
      }
    }

    this.logger.debug(
      `[EVM Snapshot] Vault ${vaultId}: Alchemy fallback completed processed=${processed} nonZero=${balances.size}`
    );

    return balances;
  }

  private async fetchAddressTokenBalanceFromAlchemy(
    rpcUrl: string,
    holderAddress: string,
    tokenAddress: Address
  ): Promise<bigint> {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'alchemy_getTokenBalances',
        params: [holderAddress, [tokenAddress.toLowerCase()]],
      }),
    });

    if (!response.ok) {
      throw new Error(`alchemy_getTokenBalances HTTP ${response.status}`);
    }

    const payload = (await response.json()) as {
      error?: { message?: string };
      result?: {
        tokenBalances?: Array<{
          contractAddress?: string;
          tokenBalance?: string | null;
        }>;
      };
    };

    if (payload.error) {
      throw new Error(payload.error.message ?? 'alchemy_getTokenBalances returned error');
    }

    const tokenBalances = payload.result?.tokenBalances ?? [];
    const tokenRow = tokenBalances.find(
      row => (row.contractAddress ?? '').toLowerCase() === tokenAddress.toLowerCase()
    );

    const rawHex = tokenRow?.tokenBalance;
    if (!rawHex || rawHex === '0x') {
      return 0n;
    }

    try {
      return BigInt(rawHex);
    } catch {
      return 0n;
    }
  }

  private extractHoldersItems(payload: unknown): unknown[] {
    if (Array.isArray(payload)) {
      return payload;
    }

    if (payload && typeof payload === 'object') {
      const candidate = (payload as { items?: unknown }).items;
      if (Array.isArray(candidate)) {
        return candidate;
      }
    }

    return [];
  }

  private extractNextPageParams(payload: unknown): Record<string, unknown> | null {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const candidate = (payload as { next_page_params?: unknown }).next_page_params;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return null;
    }

    return candidate as Record<string, unknown>;
  }

  private extractHolderAddress(item: unknown): string | null {
    if (!item || typeof item !== 'object') {
      return null;
    }

    const row = item as Record<string, unknown>;

    const direct = row.address_hash ?? row.holder_address_hash;
    if (typeof direct === 'string' && direct.startsWith('0x')) {
      return direct;
    }

    const addressField = row.address;
    if (typeof addressField === 'string' && addressField.startsWith('0x')) {
      return addressField;
    }

    if (addressField && typeof addressField === 'object') {
      const hash = (addressField as Record<string, unknown>).hash;
      if (typeof hash === 'string' && hash.startsWith('0x')) {
        return hash;
      }
    }

    return null;
  }

  private extractHolderBalance(item: unknown): string | null {
    if (!item || typeof item !== 'object') {
      return null;
    }

    const row = item as Record<string, unknown>;
    const candidates = [row.value, row.balance, row.quantity];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.length > 0) {
        return candidate;
      }
      if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        return String(Math.trunc(candidate));
      }
      if (typeof candidate === 'bigint') {
        return candidate.toString();
      }
    }

    return null;
  }

  /**
   * Approximate a block number for a timestamp using binary search.
   * Used to continue replay from the latest saved snapshot time.
   */
  private async estimateBlockForTimestamp(targetTime: Date, latestBlock: bigint): Promise<bigint> {
    const targetTs = BigInt(Math.floor(targetTime.getTime() / 1000));
    let low = 0n;
    let high = latestBlock;
    let answer = 0n;

    while (low <= high) {
      const mid = (low + high) / 2n;
      const block = await this.contractReader.publicClient.getBlock({ blockNumber: mid });
      const ts = BigInt(block.timestamp);

      if (ts <= targetTs) {
        answer = mid;
        low = mid + 1n;
      } else {
        if (mid === 0n) break;
        high = mid - 1n;
      }
    }

    return answer;
  }

  /**
   * Find the earliest block where bytecode exists at token address.
   * This avoids scanning from genesis for first-time snapshots.
   */
  private async findContractDeploymentBlock(
    vaultId: string,
    tokenAddress: Address,
    latestBlock: bigint
  ): Promise<bigint> {
    const latestCode = await this.contractReader.publicClient.getBytecode({
      address: tokenAddress,
      blockNumber: latestBlock,
    });

    if (!latestCode || latestCode === '0x') {
      return 0n;
    }

    let low = await this.factoryDeployBlock(vaultId);
    let high = latestBlock;
    let earliest = latestBlock;

    while (low <= high) {
      const mid = (low + high) / 2n;
      const codeAtMid = await this.contractReader.publicClient.getBytecode({
        address: tokenAddress,
        blockNumber: mid,
      });
      const exists = !!codeAtMid && codeAtMid !== '0x';

      if (exists) {
        earliest = mid;
        if (mid === 0n) break;
        high = mid - 1n;
      } else {
        low = mid + 1n;
      }
    }

    return earliest;
  }

  private isMissingTrieNodeError(error: unknown): boolean {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    // Nitro / Robinhood public RPC: "historical state <hash> is not available".
    return (
      message.includes('missing trie node') ||
      message.includes('state is not available') ||
      /historical state .* is not available/.test(message)
    );
  }

  /** Block of the vault's confirmed createVault tx (the VT is deployed in it), or null if unknown. */
  private async vaultCreationBlock(vaultId: string): Promise<bigint | null> {
    try {
      const createTx = await this.vaultRepository.manager.findOne(Transaction, {
        where: { vault_id: vaultId, type: TransactionType.createVault, status: TransactionStatus.confirmed },
        order: { created_at: 'DESC' },
      });
      if (!createTx?.tx_hash) return null;
      const receipt = await this.contractReader.publicClient.getTransactionReceipt({
        hash: createTx.tx_hash as `0x${string}`,
      });
      return receipt.blockNumber;
    } catch (error) {
      this.logger.warn(
        `[EVM Snapshot] Vault ${vaultId}: createVault block lookup failed — ${(error as Error).message}`
      );
      return null;
    }
  }

  /** Lower bound for VT history: the deploy block of the vault's factory, else `EVM_FACTORY_DEPLOY_BLOCK`, else 0. */
  private async factoryDeployBlock(vaultId: string): Promise<bigint> {
    const raw = this.configService.get<string>('EVM_FACTORY_DEPLOY_BLOCK')?.trim();
    const fallback = raw && /^\d+$/.test(raw) ? BigInt(raw) : 0n;
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      select: ['id', 'chain_id', 'evm_protocol_version'],
    });
    return vault ? resolveVaultDeployBlock(vault, fallback) : fallback;
  }
}
