import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { parseAbiItem, type Address, type Hex } from 'viem';

import { EvmContractReader } from './evm-contract-reader.service';

import { isRpcRateLimitError } from '@/common/evm/evm-transport';
import { EvmV4PositionScan } from '@/database/evm-v4-position-scan.entity';

export const MODIFY_LIQUIDITY_EVENT = parseAbiItem(
  'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)'
);

const POSITION_MANAGER_ABI = [
  parseAbiItem('function ownerOf(uint256 tokenId) view returns (address)'),
  parseAbiItem('function getPositionLiquidity(uint256 tokenId) view returns (uint128)'),
  parseAbiItem('function positionInfo(uint256 tokenId) view returns (uint256)'),
] as const;

const MAX_LOG_CHUNK = 2_000_000n;
const MIN_LOG_CHUNK = 5_000n;
/** A long scan saves its progress at most this often (and always when it ends or fails). */
const SAVE_EVERY_MS = 10_000;

interface ScanState {
  startBlock: bigint;
  nextBlock: bigint;
  tokenIds: Set<bigint>;
}

export interface V4Position {
  tokenId: bigint;
  owner: Address;
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
}

/**
 * Finds and reads the Uniswap v4 positions of a pool that were minted through the official
 * PositionManager: `ModifyLiquidity(sender = PositionManager)` carries the token id as `salt`.
 * Shared by LP voting (snapshots) and the vault-page pool view. Log scans are incremental per
 * pool, so repeat calls only read new blocks.
 */
@Injectable()
export class EvmV4PositionScanner {
  private readonly logger = new Logger(EvmV4PositionScanner.name);
  /** In-memory copy of the scans, keyed by `${poolId}:${positionManager}`; backed by the DB. */
  private readonly scans = new Map<string, ScanState>();
  /** One scan per pool at a time: concurrent callers (page views, snapshots) share it. */
  private readonly inFlight = new Map<string, Promise<Set<bigint>>>();
  /** Largest range the RPC accepted last time, so a scan does not re-learn it with failing calls. */
  private chunk = MAX_LOG_CHUNK;

  constructor(
    private readonly contractReader: EvmContractReader,
    @InjectRepository(EvmV4PositionScan) private readonly scanRepository: Repository<EvmV4PositionScan>
  ) {}

  /** Token ids that ever touched `poolId` in [fromBlock, toBlock] (cached, incremental). */
  async tokenIds(
    poolId: Hex,
    poolManager: Address,
    positionManager: Address,
    fromBlock: bigint,
    toBlock: bigint
  ): Promise<Set<bigint>> {
    const key = scanKey(poolId, positionManager);
    const running = this.inFlight.get(key);
    if (running) return running;
    const run = this.scan(poolId, poolManager, positionManager, fromBlock, toBlock).finally(() =>
      this.inFlight.delete(key)
    );
    this.inFlight.set(key, run);
    return run;
  }

  private async scan(
    poolId: Hex,
    poolManager: Address,
    positionManager: Address,
    fromBlock: bigint,
    toBlock: bigint
  ): Promise<Set<bigint>> {
    const key = scanKey(poolId, positionManager);
    let scan = this.scans.get(key) ?? (await this.load(poolId, positionManager));
    // A caller asking from an earlier block than the cached scan started at gets a full rescan.
    if (!scan || fromBlock < scan.startBlock) {
      scan = { startBlock: fromBlock, nextBlock: fromBlock, tokenIds: new Set() };
    }
    this.scans.set(key, scan);
    const state = scan;
    if (state.nextBlock > toBlock) return state.tokenIds;

    let lastSave = Date.now();
    try {
      // Progress is kept chunk by chunk: a scan that fails half way (e.g. a rate limit) resumes
      // where it stopped on the next call (or after a restart) instead of starting over.
      await this.forEachLogChunk<{ args: { salt?: Hex } }>(
        state.nextBlock,
        toBlock,
        (from, to) =>
          this.contractReader.publicClient.getLogs({
            address: poolManager,
            event: MODIFY_LIQUIDITY_EVENT,
            args: { id: poolId, sender: positionManager },
            fromBlock: from,
            toBlock: to,
          }),
        async (logs, to) => {
          for (const log of logs) if (log.args.salt) state.tokenIds.add(BigInt(log.args.salt));
          state.nextBlock = to + 1n;
          if (Date.now() - lastSave >= SAVE_EVERY_MS) {
            lastSave = Date.now();
            await this.save(poolId, positionManager, state);
          }
        }
      );
    } finally {
      await this.save(poolId, positionManager, state);
    }
    return state.tokenIds;
  }

  private async load(poolId: Hex, positionManager: Address): Promise<ScanState | undefined> {
    try {
      const row = await this.scanRepository.findOne({
        where: { poolId: poolId.toLowerCase(), positionManager: positionManager.toLowerCase() },
      });
      if (!row) return undefined;
      return {
        startBlock: BigInt(row.startBlock),
        nextBlock: BigInt(row.nextBlock),
        tokenIds: new Set(row.tokenIds.map(id => BigInt(id))),
      };
    } catch (error) {
      // The DB copy only saves RPC calls; without it the scan just starts from `fromBlock`.
      this.logger.warn(`Could not load v4 position scan of pool ${poolId}: ${(error as Error).message}`);
      return undefined;
    }
  }

  private async save(poolId: Hex, positionManager: Address, state: ScanState): Promise<void> {
    try {
      await this.scanRepository.save({
        poolId: poolId.toLowerCase(),
        positionManager: positionManager.toLowerCase(),
        startBlock: state.startBlock.toString(),
        nextBlock: state.nextBlock.toString(),
        tokenIds: [...state.tokenIds].map(id => id.toString()),
      });
    } catch (error) {
      this.logger.warn(`Could not save v4 position scan of pool ${poolId}: ${(error as Error).message}`);
    }
  }

  /** Owner, liquidity and tick range of `tokenId` (at `atBlock`, or latest). Null once burned. */
  async readPosition(positionManager: Address, tokenId: bigint, atBlock?: bigint): Promise<V4Position | null> {
    const client = this.contractReader.publicClient;
    const read = (functionName: 'ownerOf' | 'getPositionLiquidity' | 'positionInfo'): Promise<unknown> =>
      client.readContract({
        address: positionManager,
        abi: POSITION_MANAGER_ABI,
        functionName,
        args: [tokenId],
        ...(atBlock !== undefined ? { blockNumber: atBlock } : {}),
      });
    try {
      const [owner, liquidity, info] = (await Promise.all([
        read('ownerOf'),
        read('getPositionLiquidity'),
        read('positionInfo'),
      ])) as [Address, bigint, bigint];
      // positionInfo packs | 200 bits poolId | 24 tickUpper | 24 tickLower | 8 hasSubscriber |
      return { tokenId, owner, liquidity, tickLower: int24(info >> 8n), tickUpper: int24(info >> 32n) };
    } catch {
      return null; // burned position
    }
  }

  /**
   * getLogs over [from, to] in chunks, calling `onChunk` after each one so callers can keep
   * progress. The range shrinks when the RPC rejects it and the accepted size is remembered.
   */
  async forEachLogChunk<T>(
    from: bigint,
    to: bigint,
    fetch: (from: bigint, to: bigint) => Promise<T[]>,
    onChunk: (logs: T[], chunkEnd: bigint) => void | Promise<void>
  ): Promise<void> {
    let start = from;
    while (start <= to) {
      const end = start + this.chunk - 1n < to ? start + this.chunk - 1n : to;
      let logs: T[];
      try {
        logs = await fetch(start, end);
      } catch (error) {
        // A rate limit says nothing about the range: stop (progress so far is kept) rather than
        // shrinking the chunk and multiplying the requests that caused it.
        if (isRpcRateLimitError(error) || this.chunk <= MIN_LOG_CHUNK) throw error;
        this.chunk /= 4n;
        continue;
      }
      await onChunk(logs, end);
      start = end + 1n;
    }
  }

  /** getLogs over [from, to], shrinking the range when the RPC rejects it. */
  async getLogsChunked<T>(from: bigint, to: bigint, fetch: (from: bigint, to: bigint) => Promise<T[]>): Promise<T[]> {
    const out: T[] = [];
    await this.forEachLogChunk(from, to, fetch, logs => {
      out.push(...logs);
    });
    return out;
  }
}

const scanKey = (poolId: Hex, positionManager: Address): string =>
  `${poolId.toLowerCase()}:${positionManager.toLowerCase()}`;

const int24 = (v: bigint): number => {
  const x = Number(v & 0xffffffn);
  return x >= 0x800000 ? x - 0x1000000 : x;
};
