import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { parseAbiItem, type Address } from 'viem';

import { EvmContractReader } from '../../processing-tx/onchain/evm-contract-reader.service';
import { VAULT_ABI } from '../../processing-tx/onchain/vault.abi';

import { Snapshot } from '@/database/snapshot.entity';
import { Vault } from '@/database/vault.entity';
import { ChainType, VaultStatus } from '@/types/vault.types';

const ERC20_TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/** Block range per getLogs request — stays safely within most RPC limits. */
const LOG_CHUNK_BLOCKS = 10_000n;
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
    private readonly configService: ConfigService
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
    this.logger.debug(`[EVM Snapshot] Vault ${vaultId}: resolved vaultToken=${vtAddress}`);
    const latestSnapshot = await this.snapshotRepository.findOne({
      where: { vaultId },
      order: { createdAt: 'DESC' },
      select: ['id', 'assetId', 'addressBalances', 'createdAt'],
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

      const canTryAlchemy =
        this.hasAlchemyApiKey() &&
        canUseIncrementalBaseline &&
        !!latestSnapshot?.addressBalances &&
        Object.keys(latestSnapshot.addressBalances).length > 0;

      if (canTryAlchemy) {
        try {
          balances = await this.fetchHolderBalancesFromAlchemy(vtAddress, vaultId, latestSnapshot!);
          balanceSource = 'alchemy_token_balances';
        } catch (alchemyError) {
          const alchemyMessage = alchemyError instanceof Error ? alchemyError.message : String(alchemyError);
          this.logger.warn(
            `[EVM Snapshot] Vault ${vaultId}: Alchemy fallback failed (${alchemyMessage}). Falling back to transfer replay.`
          );

          balances = await this.buildHolderBalances(
            vtAddress,
            vaultId,
            canUseIncrementalBaseline ? latestSnapshot : null
          );
          balanceSource = 'transfer_replay';
        }
      } else {
        balances = await this.buildHolderBalances(
          vtAddress,
          vaultId,
          canUseIncrementalBaseline ? latestSnapshot : null
        );
        balanceSource = 'transfer_replay';
      }
    }

    // Serialize bigint → string to match the Snapshot.addressBalances schema.
    const addressBalancesForSnapshot: Record<string, string> = {};
    for (const [address, balance] of balances.entries()) {
      addressBalancesForSnapshot[address] = String(balance);
    }

    const snapshot = this.snapshotRepository.create({
      vaultId,
      // Use the VaultToken ERC-20 address as assetId (mirrors Cardano policy+name pattern).
      assetId: vtAddress.toLowerCase(),
      addressBalances: addressBalancesForSnapshot,
    });

    await this.snapshotRepository.save(snapshot);

    const durationMs = Date.now() - startedAt;
    this.logger.log(
      `EVM snapshot created for vault ${vaultId} — vtToken=${vtAddress} holders=${balances.size} source=${balanceSource} durationMs=${durationMs}`
    );
    return snapshot;
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
    baselineSnapshot?: Snapshot | null
  ): Promise<Map<string, bigint>> {
    const balances = baselineSnapshot
      ? this.snapshotAddressBalancesToMap(baselineSnapshot.addressBalances)
      : new Map<string, bigint>();

    const latestBlock: bigint = await this.contractReader.publicClient.getBlockNumber();
    const startedAt = Date.now();
    let chunkIndex = 0;
    let totalLogs = 0;

    let fromBlock: bigint;

    if (baselineSnapshot) {
      const estimatedBaselineBlock = await this.estimateBlockForTimestamp(baselineSnapshot.createdAt, latestBlock);
      fromBlock = estimatedBaselineBlock + 1n;
      this.logger.debug(
        `[EVM Snapshot] Vault ${vaultId}: incremental replay from block ${fromBlock.toString()} (latest=${latestBlock.toString()})`
      );
    } else {
      try {
        fromBlock = await this.findContractDeploymentBlock(vtAddress, latestBlock);
      } catch (error) {
        if (this.isMissingTrieNodeError(error)) {
          // Non-archive RPCs may fail historical eth_getCode lookups.
          // Fall back to block 0 replay so we can still build a snapshot.
          this.logger.warn(
            `[EVM Snapshot] Vault ${vaultId}: deployment block lookup failed on non-archive RPC; falling back to full replay from block 0`
          );
          fromBlock = 0n;
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

    return [mainnetBase, testnetBase];
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
      `[EVM Snapshot] Vault ${vaultId}: Alchemy fallback start rpc=${rpcUrl} token=${vtAddress.toLowerCase()} baselineHolders=${addresses.length}`
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
  private async findContractDeploymentBlock(tokenAddress: Address, latestBlock: bigint): Promise<bigint> {
    const latestCode = await this.contractReader.publicClient.getBytecode({
      address: tokenAddress,
      blockNumber: latestBlock,
    });

    if (!latestCode || latestCode === '0x') {
      return 0n;
    }

    let low = 0n;
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
    return message.includes('missing trie node') || message.includes('state is not available');
  }
}
