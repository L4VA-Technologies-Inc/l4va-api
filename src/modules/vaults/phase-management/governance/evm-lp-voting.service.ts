import { resolveVaultLpAdapter } from '@/modules/vaults/processing-tx/onchain/evm-protocol-versions';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { parseAbiItem, type Address, type Hex } from 'viem';

import { EvmContractReader } from '../../processing-tx/onchain/evm-contract-reader.service';

import { amountsForLiquidity, sqrtPriceAtTick } from './evm-lp-voting.math';

import { Vault } from '@/database/vault.entity';

const INITIALIZE_EVENT = parseAbiItem(
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)'
);
const MODIFY_LIQUIDITY_EVENT = parseAbiItem(
  'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)'
);

const LP_ADAPTER_ABI = [
  parseAbiItem('function poolManager() view returns (address)'),
  parseAbiItem('function positionManager() view returns (address)'),
  parseAbiItem('function stateView() view returns (address)'),
] as const;
const POSITION_MANAGER_ABI = [
  parseAbiItem('function ownerOf(uint256 tokenId) view returns (address)'),
  parseAbiItem('function getPositionLiquidity(uint256 tokenId) view returns (uint128)'),
  parseAbiItem('function positionInfo(uint256 tokenId) view returns (uint256)'),
] as const;
const STATE_VIEW_ABI = [
  parseAbiItem(
    'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)'
  ),
] as const;

const MAX_LOG_CHUNK = 2_000_000n;
const MIN_LOG_CHUNK = 5_000n;

interface V4Infra {
  poolManager: Address;
  positionManager: Address;
  stateView: Address;
}

interface VtPool {
  poolId: Hex;
  vtIsCurrency0: boolean;
  initBlock: bigint;
}

/** Uniswap v4 PoolManager per chain, used only when neither env nor an LP adapter provides it. */
const KNOWN_V4_POOL_MANAGER: Record<number, Address> = {
  4663: '0x8366a39CC670B4001A1121B8F6A443A643e40951', // Robinhood Chain mainnet
};

/**
 * Voting weight for VT that holders put into Uniswap v4 pools.
 *
 * The VaultToken excludes the PoolManager from voting (it would outweigh every holder of a
 * small vault), which on its own leaves liquidity providers with no say. Like the Cardano
 * snapshot does with LP tokens, the VT in each position is attributed back to the wallet that
 * owns the position NFT:
 *  - pools are found from PoolManager `Initialize` events with the VT as either currency;
 *  - positions from `ModifyLiquidity(sender = PositionManager)`, whose `salt` is the token id;
 *  - each position's VT is computed from its liquidity, tick range and the pool price.
 *
 * Positions held by the vault or by an LP adapter (protocol-owned liquidity) carry no vote.
 * Only positions minted through the official v4 PositionManager are seen.
 */
@Injectable()
export class EvmLpVotingService {
  private readonly logger = new Logger(EvmLpVotingService.name);
  /** Incremental log scans, so daily snapshots only read new blocks. */
  private readonly poolScans = new Map<string, { nextBlock: bigint; pools: Map<Hex, VtPool> }>();
  private readonly positionScans = new Map<Hex, { nextBlock: bigint; tokenIds: Set<bigint> }>();

  constructor(
    @InjectRepository(Vault) private readonly vaultRepository: Repository<Vault>,
    private readonly contractReader: EvmContractReader,
    private readonly configService: ConfigService
  ) {}

  /** VT held in v4 positions per owner (lowercase), read at `atBlock`. */
  async attributeLpVt(
    vaultId: string,
    vaultAddress: Address,
    vtAddress: Address,
    fromBlock: bigint,
    atBlock: bigint
  ): Promise<Map<string, bigint>> {
    const result = new Map<string, bigint>();
    const adapters = await this.lpAdapters(vaultId);
    const infra = await this.v4Infra(adapters);
    if (!infra) {
      this.logger.debug(`[LP voting] Vault ${vaultId}: no Uniswap v4 infra configured, skipping`);
      return result;
    }

    const nonVoters = new Set([vaultAddress, ...adapters].map(a => a.toLowerCase()));
    const pools = await this.discoverPools(vtAddress, infra.poolManager, fromBlock, atBlock);

    for (const pool of pools) {
      const [sqrtPriceX96] = (await this.contractReader.publicClient.readContract({
        address: infra.stateView,
        abi: STATE_VIEW_ABI,
        functionName: 'getSlot0',
        args: [pool.poolId],
        blockNumber: atBlock,
      })) as readonly [bigint, number, number, number];
      if (sqrtPriceX96 === 0n) continue;

      const tokenIds = await this.discoverTokenIds(pool, infra, atBlock);
      for (const tokenId of tokenIds) {
        const position = await this.readPosition(infra.positionManager, tokenId, atBlock);
        if (!position || position.liquidity === 0n) continue;

        const owner = position.owner.toLowerCase();
        if (nonVoters.has(owner)) continue;

        const { amount0, amount1 } = amountsForLiquidity(
          position.liquidity,
          sqrtPriceX96,
          sqrtPriceAtTick(position.tickLower),
          sqrtPriceAtTick(position.tickUpper)
        );
        const vt = pool.vtIsCurrency0 ? amount0 : amount1;
        if (vt > 0n) result.set(owner, (result.get(owner) ?? 0n) + vt);
      }
    }

    if (result.size > 0) {
      const total = [...result.values()].reduce((sum, v) => sum + v, 0n);
      this.logger.log(
        `[LP voting] Vault ${vaultId}: ${total} VT in ${pools.length} pool(s) attributed to ${result.size} LP owner(s)`
      );
    }
    return result;
  }

  /** The configured adapter plus every adapter that ever seeded LP for this vault. */
  private async lpAdapters(vaultId: string): Promise<Address[]> {
    const rows: Array<{ adapter: string | null }> = await this.vaultRepository.query(
      `SELECT DISTINCT lp_carveout->>'adapter' AS adapter FROM evm_valuation_snapshots
        WHERE vault_id = $1 AND lp_carveout->>'adapter' IS NOT NULL`,
      [vaultId]
    );
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      select: ['id', 'chain_id', 'evm_protocol_version'],
    });
    const raw = this.configService.get<string>('EVM_LP_ADAPTER_ADDRESS')?.trim();
    const env = raw && /^0x[0-9a-fA-F]{40}$/.test(raw) ? (raw as Address) : null;
    const configured = vault ? resolveVaultLpAdapter(vault, env) : env;
    const all = [...rows.map(r => r.adapter), configured].filter(
      (a): a is string => !!a && /^0x[0-9a-fA-F]{40}$/.test(a)
    );
    return [...new Set(all.map(a => a.toLowerCase()))] as Address[];
  }

  /**
   * The Uniswap v4 PoolManager, which custodies the VT of EVERY v4 pool (singleton). It must never
   * count as a holder: its VT is attributed to position owners instead, so counting it too would
   * double-count, and it can never claim a distribution share. Resolved even when the vault has no
   * LP adapter of ours (a third party can still create a v4 pool for its VT).
   */
  async poolManagerAddress(vaultId: string): Promise<Address | null> {
    const infra = await this.v4Infra(await this.lpAdapters(vaultId));
    if (infra) return infra.poolManager;
    const chainId = Number(this.configService.get<string>('EVM_CHAIN_ID') || 0);
    return KNOWN_V4_POOL_MANAGER[chainId] ?? null;
  }

  /** v4 core addresses from env, else from an LP adapter (a v2 adapter has none). */
  private async v4Infra(adapters: Address[]): Promise<V4Infra | null> {
    const env = (key: string): Address | undefined => {
      const v = this.configService.get<string>(key)?.trim();
      return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined;
    };
    const poolManager = env('EVM_V4_POOL_MANAGER');
    const positionManager = env('EVM_V4_POSITION_MANAGER');
    const stateView = env('EVM_V4_STATE_VIEW');
    if (poolManager && positionManager && stateView) return { poolManager, positionManager, stateView };

    const client = this.contractReader.publicClient;
    for (const adapter of adapters) {
      try {
        const [pm, posm, sv] = (await Promise.all([
          client.readContract({ address: adapter, abi: LP_ADAPTER_ABI, functionName: 'poolManager' }),
          client.readContract({ address: adapter, abi: LP_ADAPTER_ABI, functionName: 'positionManager' }),
          client.readContract({ address: adapter, abi: LP_ADAPTER_ABI, functionName: 'stateView' }),
        ])) as [Address, Address, Address];
        return { poolManager: pm, positionManager: posm, stateView: sv };
      } catch {
        continue;
      }
    }
    return null;
  }

  private async discoverPools(
    vt: Address,
    poolManager: Address,
    fromBlock: bigint,
    atBlock: bigint
  ): Promise<VtPool[]> {
    const key = vt.toLowerCase();
    let scan = this.poolScans.get(key);
    if (!scan) {
      scan = { nextBlock: fromBlock, pools: new Map() };
      this.poolScans.set(key, scan);
    }
    for (const vtIsCurrency0 of [true, false]) {
      const logs = await this.getLogsChunked<{ blockNumber: bigint; args: { id?: Hex } }>(
        scan.nextBlock,
        atBlock,
        (from, to) =>
          this.contractReader.publicClient.getLogs({
            address: poolManager,
            event: INITIALIZE_EVENT,
            args: vtIsCurrency0 ? { currency0: vt } : { currency1: vt },
            fromBlock: from,
            toBlock: to,
          })
      );
      for (const log of logs) {
        scan.pools.set(log.args.id as Hex, { poolId: log.args.id as Hex, vtIsCurrency0, initBlock: log.blockNumber });
      }
    }
    scan.nextBlock = atBlock + 1n;
    return [...scan.pools.values()];
  }

  private async discoverTokenIds(pool: VtPool, infra: V4Infra, atBlock: bigint): Promise<Set<bigint>> {
    let scan = this.positionScans.get(pool.poolId);
    if (!scan) {
      scan = { nextBlock: pool.initBlock, tokenIds: new Set() };
      this.positionScans.set(pool.poolId, scan);
    }
    const logs = await this.getLogsChunked<{ args: { salt?: Hex } }>(scan.nextBlock, atBlock, (from, to) =>
      this.contractReader.publicClient.getLogs({
        address: infra.poolManager,
        event: MODIFY_LIQUIDITY_EVENT,
        args: { id: pool.poolId, sender: infra.positionManager },
        fromBlock: from,
        toBlock: to,
      })
    );
    for (const log of logs) if (log.args.salt) scan.tokenIds.add(BigInt(log.args.salt));
    scan.nextBlock = atBlock + 1n;
    return scan.tokenIds;
  }

  private async readPosition(
    positionManager: Address,
    tokenId: bigint,
    atBlock: bigint
  ): Promise<{ owner: Address; liquidity: bigint; tickLower: number; tickUpper: number } | null> {
    const client = this.contractReader.publicClient;
    try {
      const [owner, liquidity, info] = (await Promise.all([
        client.readContract({
          address: positionManager,
          abi: POSITION_MANAGER_ABI,
          functionName: 'ownerOf',
          args: [tokenId],
          blockNumber: atBlock,
        }),
        client.readContract({
          address: positionManager,
          abi: POSITION_MANAGER_ABI,
          functionName: 'getPositionLiquidity',
          args: [tokenId],
          blockNumber: atBlock,
        }),
        client.readContract({
          address: positionManager,
          abi: POSITION_MANAGER_ABI,
          functionName: 'positionInfo',
          args: [tokenId],
          blockNumber: atBlock,
        }),
      ])) as [Address, bigint, bigint];
      // positionInfo packs | 200 bits poolId | 24 tickUpper | 24 tickLower | 8 hasSubscriber |
      return { owner, liquidity, tickLower: int24(info >> 8n), tickUpper: int24(info >> 32n) };
    } catch {
      return null; // burned position
    }
  }

  /** getLogs over [from, to], halving the range when the RPC rejects it. */
  private async getLogsChunked<T>(
    from: bigint,
    to: bigint,
    fetch: (from: bigint, to: bigint) => Promise<T[]>
  ): Promise<T[]> {
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
