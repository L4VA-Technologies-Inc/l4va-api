import { Injectable } from '@nestjs/common';
import { parseAbiItem, type Address, type Hex } from 'viem';

import { EvmContractReader } from './evm-contract-reader.service';

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
  private readonly scans = new Map<Hex, { startBlock: bigint; nextBlock: bigint; tokenIds: Set<bigint> }>();

  constructor(private readonly contractReader: EvmContractReader) {}

  /** Token ids that ever touched `poolId` in [fromBlock, toBlock] (cached, incremental). */
  async tokenIds(
    poolId: Hex,
    poolManager: Address,
    positionManager: Address,
    fromBlock: bigint,
    toBlock: bigint
  ): Promise<Set<bigint>> {
    let scan = this.scans.get(poolId);
    // A caller asking from an earlier block than the cached scan started at gets a full rescan.
    if (!scan || fromBlock < scan.startBlock) {
      scan = { startBlock: fromBlock, nextBlock: fromBlock, tokenIds: new Set() };
      this.scans.set(poolId, scan);
    }
    if (scan.nextBlock > toBlock) return scan.tokenIds;
    const logs = await this.getLogsChunked<{ args: { salt?: Hex } }>(scan.nextBlock, toBlock, (from, to) =>
      this.contractReader.publicClient.getLogs({
        address: poolManager,
        event: MODIFY_LIQUIDITY_EVENT,
        args: { id: poolId, sender: positionManager },
        fromBlock: from,
        toBlock: to,
      })
    );
    for (const log of logs) if (log.args.salt) scan.tokenIds.add(BigInt(log.args.salt));
    scan.nextBlock = toBlock + 1n;
    return scan.tokenIds;
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

  /** getLogs over [from, to], shrinking the range when the RPC rejects it. */
  async getLogsChunked<T>(from: bigint, to: bigint, fetch: (from: bigint, to: bigint) => Promise<T[]>): Promise<T[]> {
    const out: T[] = [];
    let chunk = MAX_LOG_CHUNK;
    let start = from;
    while (start <= to) {
      const end = start + chunk - 1n < to ? start + chunk - 1n : to;
      try {
        out.push(...(await fetch(start, end)));
        start = end + 1n;
      } catch (error) {
        if (chunk <= MIN_LOG_CHUNK) throw error;
        chunk /= 4n;
      }
    }
    return out;
  }
}

const int24 = (v: bigint): number => {
  const x = Number(v & 0xffffffn);
  return x >= 0x800000 ? x - 0x1000000 : x;
};
