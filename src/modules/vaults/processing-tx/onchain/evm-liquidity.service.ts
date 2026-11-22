import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  encodeAbiParameters,
  encodePacked,
  formatUnits,
  keccak256,
  toBytes,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';

import { EvmAdminSigner } from './evm-admin-signer.service';
import { EvmContractReader } from './evm-contract-reader.service';
import {
  EvmLpStatus,
  getEvmLpMaxPriceDeviationBps,
  getEvmLpV4PoolCandidates,
  lpTechnicalCycleRoot,
  type EvmLpCarveoutRecord,
} from './evm-lp.config';
import { EvmLpMode, v13FromSaleRate, vaultIsV13, VAULT_V13_ABI } from './evm-v13';
import { aggregateV4Positions } from './evm-v4-pool-view.math';
import { EvmV4PositionScanner, type V4Position } from './evm-v4-position-scanner.service';
import { EvmCycleStatus, EvmVaultOnchainStatus, VAULT_ABI } from './vault.abi';

import { EvmSnapshotStatus, EvmValuationSnapshot } from '@/database/evm-valuation-snapshot.entity';
import { Vault } from '@/database/vault.entity';
import { AlertsService } from '@/modules/alerts/alerts.service';
import { ChainType } from '@/types/vault.types';

const LP_ADAPTER_ABI = [
  { type: 'function', stateMutability: 'view', name: 'protocolTag', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', stateMutability: 'view', name: 'factory', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', stateMutability: 'view', name: 'weth', inputs: [], outputs: [{ type: 'address' }] },
  // UniswapV4LiquidityAdapter
  { type: 'function', stateMutability: 'view', name: 'poolManager', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', stateMutability: 'view', name: 'positionManager', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', stateMutability: 'view', name: 'stateView', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'function',
    stateMutability: 'view',
    name: 'positionsOf',
    inputs: [{ name: 'vault', type: 'address' }],
    outputs: [{ type: 'uint256[]' }],
  },
  {
    type: 'function',
    stateMutability: 'pure',
    name: 'poolKeyFor',
    inputs: [
      { name: 'vtToken', type: 'address' },
      { name: 'protocolParams', type: 'bytes' },
    ],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'currency0', type: 'address' },
          { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'hooks', type: 'address' },
        ],
      },
    ],
  },
] as const;

const V4_STATE_VIEW_ABI = [
  {
    type: 'function',
    stateMutability: 'view',
    name: 'getSlot0',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [{ type: 'uint160' }, { type: 'int24' }, { type: 'uint24' }, { type: 'uint24' }],
  },
  {
    type: 'function',
    stateMutability: 'view',
    name: 'getLiquidity',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [{ type: 'uint128' }],
  },
] as const;

const V2_TAG = keccak256(toBytes('uniswap-v2-lp'));
const V4_TAG = keccak256(toBytes('uniswap-v4-lp'));

/** Where the vault's LP goes, resolved from the adapter's protocol tag. */
type LpVenue =
  | { protocol: 'uniswap-v2'; positionAsset: Address; vtPool: Address; protocolParams: Hex; pair: Address }
  | { protocol: 'uniswap-v4'; positionAsset: Address; vtPool: Address; protocolParams: Hex; poolId: Hex };

const V2_FACTORY_ABI = [
  {
    type: 'function',
    stateMutability: 'view',
    name: 'getPair',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
    ],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'createPair',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
    ],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'event',
    name: 'PairCreated',
    inputs: [
      { name: 'token0', type: 'address', indexed: true },
      { name: 'token1', type: 'address', indexed: true },
      { name: 'pair', type: 'address', indexed: false },
      { name: '', type: 'uint256', indexed: false },
    ],
  },
] as const;

const V2_PAIR_ABI = [
  {
    type: 'function',
    stateMutability: 'view',
    name: 'getReserves',
    inputs: [],
    outputs: [{ type: 'uint112' }, { type: 'uint112' }, { type: 'uint32' }],
  },
  { type: 'function', stateMutability: 'view', name: 'token0', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', stateMutability: 'view', name: 'totalSupply', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    stateMutability: 'view',
    name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  { type: 'function', stateMutability: 'view', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

/** Vault LP pool as shown on the vault page. Token amounts are human units (decimal strings). */
export interface EvmLpPositionView {
  tokenId: string;
  owner: string;
  /** Held by the vault or its LP adapter (protocol-owned). */
  isVault: boolean;
  /** Current tick inside [tickLower, tickUpper): the position earns fees and holds both tokens. */
  inRange: boolean;
  tickLower: number;
  tickUpper: number;
  vt: string;
  native: string;
  valueNative: string;
  /** Share of the pool by value, 0..100. Voting/payouts count only `vt`. */
  sharePct: number | null;
}

export interface EvmVaultLpView {
  status: EvmLpStatus;
  protocol: 'uniswap-v2' | 'uniswap-v4' | null;
  /** V2 pair address (also the LP token). Null for v4. */
  pair: string | null;
  /** v4 pool id. Null for V2. */
  poolId: string | null;
  /** v4 PositionManager and the vault's position NFT ids (held by the adapter). */
  positionManager: string | null;
  positionIds: string[];
  vaultToken: string | null;
  reserveVt: string | null;
  reserveNative: string | null;
  /** Native per 1 VT. */
  vtPriceNative: string | null;
  vaultLpTokens: string | null;
  lpTotalSupply: string | null;
  /** Share of the pool the vault owns, 0..100. */
  vaultSharePct: number | null;
  /** Token the vault holds for its position: the V2 pair, or the v4 adapter's receipt. */
  lpToken: string | null;
  /** The vault's share of the pool in native wei (both sides, valued at the pool price). */
  vaultValueNative: string | null;
  /** v4: every position's value summed, in native (decimal string). */
  totalValueNative?: string | null;
  /** v4: tokens held by the vault's own positions (decimal strings). */
  vaultVt?: string | null;
  vaultNative?: string | null;
  /** v4: in-range liquidity only (`StateView.getLiquidity`), for reference. */
  activeLiquidity?: string | null;
  /** v4: number of live positions in the pool (vault + other LPs). */
  positionCount?: number;
  /** v4: every live position, vault first, then by value. */
  positions?: EvmLpPositionView[];
  lastError: string | null;
}

const MAX_ATTEMPTS = 5;
/** Vault-page view cache: the view costs several RPC reads and pages poll it. */
const VIEW_TTL_MS = 30_000;
const DEADLINE_SECONDS = 30 * 60;

/**
 * Seeds the vault token's pool (Uniswap v4 by default, V2 as a fallback) right
 * after an EVM vault's raise closes. The venue follows `EVM_LP_ADAPTER_ADDRESS`.
 *
 * The LP price lives in the cycle (`adaPairVtPerNativeUnit`) and is fixed at
 * `openCycle`, before we know how much will be raised. So instead of the raise
 * cycle's rate, the pool is seeded from a short technical cycle opened with the
 * rate computed from the actual raise (snapshot `lp_carveout`):
 *
 *   createPair (V2 only, if missing)
 *   → openCycle(windows 0/0, rate)        vault: Locked → Active, nobody can contribute
 *   → provideLiquidity(lpNative)          VT minted at `rate` + ETH → pair, LP → vault
 *   → closeCycle(empty allocation)        vault: Active → Locked
 *
 * Every step is re-derived from chain state, so a crash at any point resumes
 * where it stopped on the next tick. The DB only keeps the outcome
 * (`snapshot.lp_carveout.status`).
 *
 * The technical cycle is never written to the DB (`evm_current_cycle_id` keeps
 * the raise cycle, `vault_status` stays locked), so contributions, expansion
 * and index buys keep treating the raise as the vault's latest cycle.
 */
@Injectable()
export class EvmLiquidityService {
  private readonly logger = new Logger(EvmLiquidityService.name);
  private readonly processing = new Set<string>();
  private readonly viewCache = new Map<string, { at: number; view: EvmVaultLpView | null }>();
  private readonly poolStartBlocks = new Map<Hex, bigint>();

  constructor(
    @InjectRepository(Vault) private readonly vaultsRepository: Repository<Vault>,
    @InjectRepository(EvmValuationSnapshot) private readonly snapshotsRepository: Repository<EvmValuationSnapshot>,
    private readonly contractReader: EvmContractReader,
    private readonly adminSigner: EvmAdminSigner,
    private readonly alerts: AlertsService,
    private readonly positionScanner: EvmV4PositionScanner
  ) {}

  /** Cron entry: every confirmed raise whose pool is not seeded yet. */
  async processPending(): Promise<void> {
    const pending = await this.snapshotsRepository
      .createQueryBuilder('snap')
      .innerJoin(Vault, 'vault', 'vault.id = snap.vault_id')
      .where('snap.status = :status', { status: EvmSnapshotStatus.confirmed })
      .andWhere(`snap.lp_carveout->>'status' = :lp`, { lp: EvmLpStatus.pending })
      .andWhere('vault.chain_type = :chain', { chain: ChainType.robinhood })
      .getMany();

    for (const snap of pending) {
      await this.provideForSnapshot(snap.id).catch(err => {
        this.logger.error(`LP for snapshot ${snap.id} failed: ${(err as Error).message}`);
        void this.alerts.sendAlert('evm_lp_failed', {
          chain: 'robinhood',
          snapshotId: snap.id,
          error: (err as Error).message,
        });
      });
    }
  }

  /** True while the vault's raise still owes the pool its native (index buys must wait). */
  async isLpPending(vaultId: string, cycleId: string): Promise<boolean> {
    const snap = await this.snapshotsRepository.findOne({
      where: { vault_id: vaultId, cycle_id: cycleId },
      select: ['id', 'lp_carveout'],
    });
    return (snap?.lp_carveout as Partial<EvmLpCarveoutRecord> | undefined)?.status === EvmLpStatus.pending;
  }

  /**
   * The vault's seeded pool with live reserves, or its LP status while it is not
   * seeded yet. Null when the vault has no LP carveout at all.
   */
  async getVaultLp(vaultId: string): Promise<EvmVaultLpView | null> {
    const cached = this.viewCache.get(vaultId);
    if (cached && Date.now() - cached.at < VIEW_TTL_MS) return cached.view;
    const view = await this.loadVaultLp(vaultId);
    this.viewCache.set(vaultId, { at: Date.now(), view });
    return view;
  }

  private async loadVaultLp(vaultId: string): Promise<EvmVaultLpView | null> {
    const snap = await this.snapshotsRepository
      .createQueryBuilder('snap')
      .where('snap.vault_id = :vaultId', { vaultId })
      .andWhere(`snap.lp_carveout ? 'status'`)
      .orderBy('snap.cycle_id', 'DESC')
      .getOne();
    const lp = snap?.lp_carveout as unknown as EvmLpCarveoutRecord | undefined;
    if (!lp) return null;

    const empty: EvmVaultLpView = {
      status: lp.status,
      protocol: lp.protocol ?? (lp.pair ? 'uniswap-v2' : null),
      pair: lp.pair ?? null,
      poolId: lp.poolId ?? null,
      positionManager: null,
      positionIds: [],
      vaultToken: null,
      reserveVt: null,
      reserveNative: null,
      vtPriceNative: null,
      vaultLpTokens: null,
      lpTotalSupply: null,
      vaultSharePct: null,
      lpToken: lp.protocol === 'uniswap-v4' ? (lp.adapter ?? null) : (lp.pair ?? null),
      vaultValueNative: null,
      lastError: lp.lastError ?? null,
    };
    const vault = await this.vaultsRepository.findOne({ where: { id: vaultId }, select: ['id', 'contract_address'] });
    if (lp.status !== EvmLpStatus.provided || !vault?.contract_address) return empty;
    if (lp.protocol === 'uniswap-v4') return this.getV4View(empty, lp, vault.contract_address as Address);
    if (!lp.pair) return empty;

    const client = this.contractReader.publicClient;
    const pair = lp.pair as Address;
    const vaultAddress = vault.contract_address as Address;
    const read = (functionName: 'getReserves' | 'token0' | 'totalSupply'): Promise<unknown> =>
      client.readContract({ address: pair, abi: V2_PAIR_ABI, functionName });
    const [reserves, token0, totalSupply, vaultLp, vt] = (await Promise.all([
      read('getReserves'),
      read('token0'),
      read('totalSupply'),
      client.readContract({ address: pair, abi: V2_PAIR_ABI, functionName: 'balanceOf', args: [vaultAddress] }),
      client.readContract({ address: vaultAddress, abi: VAULT_ABI, functionName: 'vaultToken' }),
    ])) as [readonly [bigint, bigint, number], Address, bigint, bigint, Address];
    const vtDecimals = Number(await client.readContract({ address: vt, abi: V2_PAIR_ABI, functionName: 'decimals' }));

    const vtIs0 = token0.toLowerCase() === vt.toLowerCase();
    const [rawVt, rawNative] = vtIs0 ? [reserves[0], reserves[1]] : [reserves[1], reserves[0]];
    const reserveVt = formatUnits(rawVt, vtDecimals);
    const reserveNative = formatUnits(rawNative, 18);

    return {
      ...empty,
      vaultToken: vt,
      reserveVt,
      reserveNative,
      vtPriceNative: rawVt > 0n ? (Number(reserveNative) / Number(reserveVt)).toString() : null,
      vaultLpTokens: formatUnits(vaultLp, 18),
      lpTotalSupply: formatUnits(totalSupply, 18),
      vaultSharePct: totalSupply > 0n ? Number((vaultLp * 1_000_000n) / totalSupply) / 10_000 : null,
      vaultValueNative: totalSupply > 0n ? ((2n * rawNative * vaultLp) / totalSupply).toString() : null,
    };
  }

  /**
   * v4 pool view over EVERY position in the pool, not just the vault's. Positions are found
   * through the shared scanner (PositionManager mints), each one's token amounts come from its own
   * tick range at the current price, so out-of-range LPs (one token only) count too. Pool totals are
   * sums over positions; shares are by value. `activeLiquidity` is the in-range liquidity only.
   */
  private async getV4View(
    base: EvmVaultLpView,
    lp: EvmLpCarveoutRecord,
    vaultAddress: Address
  ): Promise<EvmVaultLpView> {
    const client = this.contractReader.publicClient;
    const adapter = lp.adapter as Address;
    const poolId = lp.poolId as Hex;
    const [positionManager, poolManager, stateView, ids, vt] = (await Promise.all([
      client.readContract({ address: adapter, abi: LP_ADAPTER_ABI, functionName: 'positionManager' }),
      client.readContract({ address: adapter, abi: LP_ADAPTER_ABI, functionName: 'poolManager' }),
      client.readContract({ address: adapter, abi: LP_ADAPTER_ABI, functionName: 'stateView' }),
      client.readContract({ address: adapter, abi: LP_ADAPTER_ABI, functionName: 'positionsOf', args: [vaultAddress] }),
      client.readContract({ address: vaultAddress, abi: VAULT_ABI, functionName: 'vaultToken' }),
    ])) as [Address, Address, Address, readonly bigint[], Address];

    const [slot0, activeLiquidity, vtDecimals, latestBlock, fromBlock] = (await Promise.all([
      client.readContract({ address: stateView, abi: V4_STATE_VIEW_ABI, functionName: 'getSlot0', args: [poolId] }),
      client.readContract({ address: stateView, abi: V4_STATE_VIEW_ABI, functionName: 'getLiquidity', args: [poolId] }),
      client.readContract({ address: vt, abi: V2_PAIR_ABI, functionName: 'decimals' }),
      client.getBlockNumber(),
      this.poolStartBlock(poolId, lp.provideTxHash),
    ])) as [readonly [bigint, number, number, number], bigint, number, bigint, bigint];

    const tokenIds = new Set<bigint>(ids);
    for (const id of await this.positionScanner.tokenIds(
      poolId,
      poolManager,
      positionManager,
      fromBlock,
      latestBlock
    )) {
      tokenIds.add(id);
    }
    const positions = (
      await Promise.all([...tokenIds].map(id => this.positionScanner.readPosition(positionManager, id)))
    ).filter((p): p is V4Position => p !== null);

    const sqrtP = slot0[0];
    const decimals = Number(vtDecimals);
    const vaultOwners = new Set([vaultAddress.toLowerCase(), adapter.toLowerCase()]);
    const totals = aggregateV4Positions({
      positions,
      sqrtPriceX96: sqrtP,
      tick: Number(slot0[1]),
      // The vault pool key is (native, VT); native = address(0) always sorts first.
      vtIsCurrency0: false,
      isVault: owner => vaultOwners.has(owner),
    });
    // price (VT per native, raw) = sqrtP² / 2^192 → native per whole VT:
    const vtPriceNative =
      sqrtP > 0n ? (Number((2n ** 192n * 10n ** BigInt(decimals)) / (sqrtP * sqrtP)) / 1e18).toString() : null;
    const vaultLiquidity = positions.filter(p => ids.includes(p.tokenId)).reduce((s, p) => s + p.liquidity, 0n);

    return {
      ...base,
      protocol: 'uniswap-v4',
      positionManager,
      positionIds: ids.map(id => id.toString()),
      vaultToken: vt,
      reserveVt: formatUnits(totals.totalVt, decimals),
      reserveNative: formatUnits(totals.totalNative, 18),
      vtPriceNative,
      vaultLpTokens: vaultLiquidity.toString(),
      lpTotalSupply: activeLiquidity.toString(),
      vaultSharePct: totals.vaultSharePct,
      vaultValueNative: totals.vaultValueNative.toString(),
      totalValueNative: formatUnits(totals.totalValueNative, 18),
      vaultVt: formatUnits(totals.vaultVt, decimals),
      vaultNative: formatUnits(totals.vaultNative, 18),
      activeLiquidity: activeLiquidity.toString(),
      positionCount: totals.positions.length,
      positions: totals.positions.map(p => ({
        tokenId: p.tokenId.toString(),
        owner: p.owner,
        isVault: p.isVault,
        inRange: p.inRange,
        tickLower: p.tickLower,
        tickUpper: p.tickUpper,
        vt: formatUnits(p.vt, decimals),
        native: formatUnits(p.native, 18),
        valueNative: formatUnits(p.valueNative, 18),
        sharePct: p.sharePct,
      })),
    };
  }

  /** Block the pool's positions are scanned from: the vault's seeding tx, cached per pool. */
  private async poolStartBlock(poolId: Hex, provideTxHash?: string): Promise<bigint> {
    const cached = this.poolStartBlocks.get(poolId);
    if (cached !== undefined) return cached;
    let block = 0n;
    if (provideTxHash) {
      try {
        const receipt = await this.contractReader.publicClient.getTransactionReceipt({ hash: provideTxHash as Hex });
        block = receipt.blockNumber;
      } catch (error) {
        this.logger.warn(`LP view: no receipt for ${provideTxHash}, scanning pool ${poolId} from block 0 — ${error}`);
      }
    }
    this.poolStartBlocks.set(poolId, block);
    return block;
  }

  async provideForSnapshot(snapshotId: string): Promise<void> {
    if (this.processing.has(snapshotId)) return;
    this.processing.add(snapshotId);
    try {
      await this.run(snapshotId);
    } finally {
      this.processing.delete(snapshotId);
    }
  }

  private async run(snapshotId: string): Promise<void> {
    const snap = await this.snapshotsRepository.findOne({ where: { id: snapshotId } });
    const lp = snap?.lp_carveout as unknown as EvmLpCarveoutRecord | undefined;
    if (!snap || snap.status !== EvmSnapshotStatus.confirmed || lp?.status !== EvmLpStatus.pending) return;

    const vault = await this.vaultsRepository.findOne({ where: { id: snap.vault_id } });
    if (!vault?.contract_address) return;
    if (vaultIsV13(vault)) return this.runV13(snap, vault, lp);
    const vaultAddress = vault.contract_address as Address;
    const raiseCycleId = BigInt(snap.cycle_id);
    const rate = BigInt(lp.rate);
    const lpNative = BigInt(lp.lpNativeAmount);
    const adapter = lp.adapter as Address;
    const operationId = keccak256(
      encodePacked(['address', 'uint256', 'string'], [vaultAddress, raiseCycleId, 'l4va-lp-on-close'])
    );

    try {
      const venue = await this.resolveVenue(vaultAddress, adapter, rate);
      const where = venue.protocol === 'uniswap-v4' ? { poolId: venue.poolId } : { pair: venue.pair };
      await this.saveLp(snap.id, { ...lp, protocol: venue.protocol, ...where });

      let positionId = await this.findPosition(vaultAddress, operationId);

      if (positionId === null) {
        const technicalCycleId = await this.ensureTechnicalCycle(vaultAddress, raiseCycleId, rate);
        await this.saveLp(snap.id, {
          ...lp,
          protocol: venue.protocol,
          ...where,
          technicalCycleId: technicalCycleId.toString(),
        });

        const result = await this.adminSigner.sendAndConfirm(
          {
            address: vaultAddress,
            abi: VAULT_ABI,
            functionName: 'provideLiquidity',
            args: [
              {
                operationId,
                adapter,
                nativeAmount: lpNative,
                expectedPositionAsset: venue.positionAsset,
                minPositionAmount: 1n,
                deadline: BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS),
                vtPool: venue.vtPool,
                protocolParams: venue.protocolParams,
              },
            ],
          },
          ['LiquidityProvided']
        );
        this.logger.log(`provideLiquidity (${venue.protocol}) vault=${vault.id} native=${lpNative} tx=${result.hash}`);
        await this.saveLp(snap.id, {
          ...lp,
          protocol: venue.protocol,
          ...where,
          technicalCycleId: technicalCycleId.toString(),
          provideTxHash: result.hash,
        });
        positionId = await this.findPosition(vaultAddress, operationId);
        if (positionId === null) throw new Error(`LiquidityProvided confirmed but position ${operationId} not found`);
      }

      await this.closeTechnicalCycleIfOpen(vaultAddress, raiseCycleId);

      const position = (await this.contractReader.publicClient.readContract({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: 'getLiquidityPosition',
        args: [positionId],
      })) as { positionAmount: bigint; cycleId: bigint };

      const fresh = (await this.snapshotsRepository.findOne({ where: { id: snap.id } }))!
        .lp_carveout as unknown as EvmLpCarveoutRecord;
      await this.saveLp(snap.id, {
        ...fresh,
        status: EvmLpStatus.provided,
        protocol: venue.protocol,
        ...where,
        technicalCycleId: position.cycleId.toString(),
        lpPositionId: positionId.toString(),
        lpTokens: position.positionAmount.toString(),
        lastError: undefined,
      });
      await this.vaultsRepository.update({ id: vault.id }, { has_active_lp: true });
      this.logger.log(
        `LP seeded for vault ${vault.id} on ${venue.protocol}: ${JSON.stringify(where)} position=${positionId}`
      );
    } catch (err) {
      const message = ((err as Error).message || String(err)).slice(0, 500);
      const attempts = (lp.attempts ?? 0) + 1;
      const fresh = ((await this.snapshotsRepository.findOne({ where: { id: snap.id } }))?.lp_carveout ??
        lp) as unknown as EvmLpCarveoutRecord;
      const giveUp = attempts >= MAX_ATTEMPTS;
      await this.saveLp(snap.id, {
        ...fresh,
        attempts,
        lastError: message,
        status: giveUp ? EvmLpStatus.failed : EvmLpStatus.pending,
      });
      // Never leave the vault parked in Active on our technical cycle: expansion,
      // termination and every Locked-only flow would be blocked for good.
      if (giveUp) {
        await this.closeTechnicalCycleIfOpen(vaultAddress, raiseCycleId).catch(closeErr => {
          this.logger.error(
            `LP failed for vault ${vault.id} and its technical cycle could not be closed: ${(closeErr as Error).message}`
          );
          void this.alerts.sendAlert('evm_lp_cycle_close_failed', {
            chain: 'robinhood',
            vaultId: vault.id,
            error: (closeErr as Error).message,
          });
        });
      }
      throw err;
    }
  }

  /**
   * V13: no technical cycle. The vault holds the pool's price (`lpVtPerNative`) and ETH budget
   * (`lpNativeBudget`) since its raise closed; this spends the whole budget in one
   * `provideLiquidity`. FromSale fixes the price at that call from the slice sale, so it waits
   * until every slice is sold (EvmV13LpSaleService) and the venue check uses the price the
   * contract is about to fix.
   */
  private async runV13(snap: EvmValuationSnapshot, vault: Vault, lp: EvmLpCarveoutRecord): Promise<void> {
    const vaultAddress = vault.contract_address as Address;
    const client = this.contractReader.publicClient;
    const read = async <T>(functionName: string, args: unknown[] = []): Promise<T> =>
      (await client.readContract({ address: vaultAddress, abi: VAULT_V13_ABI, functionName, args })) as T;
    const adapter = lp.adapter as Address;
    const operationId = keccak256(
      encodePacked(['address', 'uint256', 'string'], [vaultAddress, BigInt(snap.cycle_id), 'l4va-v13-lp'])
    );

    try {
      let positionId = await this.findPosition(vaultAddress, operationId);
      let protocol: LpVenue['protocol'] | undefined;
      let where: { poolId?: string; pair?: string } = {};
      if (positionId === null) {
        const budget = await read<bigint>('lpNativeBudget');
        if (budget === 0n) throw new Error(`vault ${vaultAddress} has no LP budget left`);

        const rate = await read<bigint>('lpVtPerNative');
        if (lp.lpMode === EvmLpMode.FromSale) {
          // Audit F-02: the sale's rate is proposed on-chain, waits `allocationDelay` (the
          // Safe or the verifier may cancel it), and only then seeds the pool.
          if (await read<boolean>('lpRateCancelled')) {
            this.logger.warn(`V13 LP for vault ${vault.id}: sale rate was cancelled; pool not seeded`);
            return;
          }
          if (rate === 0n) {
            for (const token of await read<Address[]>('lpSliceTokens')) {
              const [slice, sold] = await read<readonly [bigint, bigint]>('lpSlice', [token]);
              if (sold < slice) {
                this.logger.log(`V13 LP for vault ${vault.id} waits for its ${token} slice (${sold}/${slice} sold)`);
                return;
              }
            }
            const [lpSaleVt, proceeds] = await Promise.all([read<bigint>('lpSaleVt'), read<bigint>('lpSaleProceeds')]);
            if (v13FromSaleRate(lpSaleVt, proceeds) === 0n)
              throw new Error(`vault ${vaultAddress}: LP sale raised nothing`);
            const proposed = await this.adminSigner.sendAndConfirm(
              { address: vaultAddress, abi: VAULT_V13_ABI, functionName: 'proposeLpRate', args: [] },
              ['LpRateProposed']
            );
            this.logger.log(`V13 proposeLpRate vault=${vault.id} tx=${proposed.hash}; seeding after the delay`);
            return;
          }
          const activatesAt = await read<bigint>('lpRateActivatesAt');
          if (BigInt(Math.floor(Date.now() / 1000)) < activatesAt) {
            this.logger.log(`V13 LP for vault ${vault.id} waits for its sale rate to open at ${activatesAt}`);
            return;
          }
        }
        if (rate === 0n) throw new Error(`vault ${vaultAddress} has no LP price`);

        const venue = await this.resolveVenue(vaultAddress, adapter, rate);
        protocol = venue.protocol;
        where = venue.protocol === 'uniswap-v4' ? { poolId: venue.poolId } : { pair: venue.pair };
        await this.saveLp(snap.id, { ...lp, protocol, ...where, rate: rate.toString() });

        const result = await this.adminSigner.sendAndConfirm(
          {
            address: vaultAddress,
            abi: VAULT_V13_ABI,
            functionName: 'provideLiquidity',
            args: [
              {
                operationId,
                adapter,
                nativeAmount: budget,
                expectedPositionAsset: venue.positionAsset,
                minPositionAmount: 1n,
                deadline: BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS),
                vtPool: venue.vtPool,
                protocolParams: venue.protocolParams,
              },
            ],
          },
          ['LiquidityProvided']
        );
        this.logger.log(
          `V13 provideLiquidity (${venue.protocol}) vault=${vault.id} native=${budget} tx=${result.hash}`
        );
        await this.saveLp(snap.id, {
          ...lp,
          protocol,
          ...where,
          rate: rate.toString(),
          lpNativeAmount: budget.toString(),
          provideTxHash: result.hash,
        });
        positionId = await this.findPosition(vaultAddress, operationId);
        if (positionId === null) throw new Error(`LiquidityProvided confirmed but position ${operationId} not found`);
      }

      const position = (await client.readContract({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: 'getLiquidityPosition',
        args: [positionId],
      })) as { positionAmount: bigint; vtAmount?: bigint };
      const fresh = (await this.snapshotsRepository.findOne({ where: { id: snap.id } }))!
        .lp_carveout as unknown as EvmLpCarveoutRecord;
      await this.saveLp(snap.id, {
        ...fresh,
        status: EvmLpStatus.provided,
        ...(protocol ? { protocol, ...where } : {}),
        lpPositionId: positionId.toString(),
        lpTokens: position.positionAmount.toString(),
        lastError: undefined,
      });
      await this.vaultsRepository.update({ id: vault.id }, { has_active_lp: true });
      this.logger.log(`V13 LP seeded for vault ${vault.id}: position=${positionId}`);
    } catch (err) {
      const message = ((err as Error).message || String(err)).slice(0, 500);
      const attempts = (lp.attempts ?? 0) + 1;
      const fresh = ((await this.snapshotsRepository.findOne({ where: { id: snap.id } }))?.lp_carveout ??
        lp) as unknown as EvmLpCarveoutRecord;
      // Nothing to unwind in V13: the vault never leaves Locked for the LP.
      await this.saveLp(snap.id, {
        ...fresh,
        attempts,
        lastError: message,
        status: attempts >= MAX_ATTEMPTS ? EvmLpStatus.failed : EvmLpStatus.pending,
      });
      throw err;
    }
  }

  /**
   * Resolves the LP venue from the adapter's protocol tag:
   *  - v4: the adapter initializes the pool itself and books its own receipt
   *    token as the position; v4 keeps every pool's tokens in the PoolManager.
   *  - V2: the pair must exist before the call (the vault reads its balance first).
   * `rate` is the LP price (VT per native, 1e18-scaled) used to skip v4 tiers
   * someone initialized at another price.
   */
  private async resolveVenue(vaultAddress: Address, adapter: Address, rate: bigint): Promise<LpVenue> {
    const client = this.contractReader.publicClient;
    const tag = (await client.readContract({
      address: adapter,
      abi: LP_ADAPTER_ABI,
      functionName: 'protocolTag',
    })) as Hex;
    const maxDev = getEvmLpMaxPriceDeviationBps();

    if (tag === V4_TAG) {
      const [poolManager, stateView, vt] = await Promise.all([
        client.readContract({ address: adapter, abi: LP_ADAPTER_ABI, functionName: 'poolManager' }) as Promise<Address>,
        client.readContract({ address: adapter, abi: LP_ADAPTER_ABI, functionName: 'stateView' }) as Promise<Address>,
        client.readContract({ address: vaultAddress, abi: VAULT_ABI, functionName: 'vaultToken' }) as Promise<Address>,
      ]);

      // First tier whose pool is uninitialized or trades at our price. v4 pools
      // initialize once, so a tier someone pre-initialized elsewhere is skipped.
      for (const { fee, tickSpacing } of getEvmLpV4PoolCandidates()) {
        const protocolParams = encodeAbiParameters(
          [{ type: 'uint24' }, { type: 'int24' }, { type: 'uint16' }],
          [fee, tickSpacing, maxDev]
        );
        const key = (await client.readContract({
          address: adapter,
          abi: LP_ADAPTER_ABI,
          functionName: 'poolKeyFor',
          args: [vt, protocolParams],
        })) as { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
        const poolId = keccak256(
          encodeAbiParameters(
            [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
            [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
          )
        );
        const [sqrtP] = (await client.readContract({
          address: stateView,
          abi: V4_STATE_VIEW_ABI,
          functionName: 'getSlot0',
          args: [poolId],
        })) as readonly [bigint, number, number, number];

        if (sqrtP === 0n || this.priceWithin(sqrtP, rate, maxDev)) {
          if (sqrtP !== 0n) this.logger.log(`v4 pool ${poolId} (fee ${fee}) already exists at our price — joining it`);
          return { protocol: 'uniswap-v4', positionAsset: adapter, vtPool: poolManager, protocolParams, poolId };
        }
        this.logger.warn(
          `v4 pool ${poolId} (fee ${fee}/${tickSpacing}) was initialized at another price — trying next tier`
        );
      }
      throw new Error(`every v4 fee tier for VT ${vt} is initialized at a foreign price`);
    }

    if (tag !== V2_TAG) throw new Error(`LP adapter ${adapter} has unknown protocol tag ${tag}`);
    const pair = await this.ensurePair(vaultAddress, adapter);
    return {
      protocol: 'uniswap-v2',
      positionAsset: pair,
      vtPool: pair,
      protocolParams: encodeAbiParameters([{ type: 'uint16' }], [maxDev]),
      pair,
    };
  }

  /** Pool price sqrtP (VT per native, X96) within maxDev bps of `rate` (1e18-scaled). */
  private priceWithin(sqrtPriceX96: bigint, rate: bigint, maxDevBps: number): boolean {
    const poolPrice = (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) >> 192n; // 1e18-scaled
    const diff = poolPrice > rate ? poolPrice - rate : rate - poolPrice;
    return diff * 10_000n <= rate * BigInt(maxDevBps);
  }

  /** VT/WETH pair address, created through the adapter's factory if missing. */
  private async ensurePair(vaultAddress: Address, adapter: Address): Promise<Address> {
    const client = this.contractReader.publicClient;
    const [factory, weth, vt] = (await Promise.all([
      client.readContract({ address: adapter, abi: LP_ADAPTER_ABI, functionName: 'factory' }),
      client.readContract({ address: adapter, abi: LP_ADAPTER_ABI, functionName: 'weth' }),
      client.readContract({ address: vaultAddress, abi: VAULT_ABI, functionName: 'vaultToken' }),
    ])) as [Address, Address, Address];

    const getPair = async (): Promise<Address> =>
      (await client.readContract({
        address: factory,
        abi: V2_FACTORY_ABI,
        functionName: 'getPair',
        args: [vt, weth],
      })) as Address;

    let pair = await getPair();
    if (pair === zeroAddress) {
      const result = await this.adminSigner.sendAndConfirm(
        { address: factory, abi: V2_FACTORY_ABI, functionName: 'createPair', args: [vt, weth] },
        ['PairCreated']
      );
      pair = await getPair();
      this.logger.log(`createPair VT=${vt} WETH=${weth} → ${pair} tx=${result.hash}`);
    }
    return pair;
  }

  /** Id of the vault's LP position opened with `operationId`, or null. */
  private async findPosition(vaultAddress: Address, operationId: Hex): Promise<bigint | null> {
    const client = this.contractReader.publicClient;
    const total = (await client.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'totalLiquidityPositions',
    })) as bigint;
    for (let id = total; id >= 1n; id--) {
      const p = (await client.readContract({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: 'getLiquidityPosition',
        args: [id],
      })) as { operationId: Hex };
      if (p.operationId.toLowerCase() === operationId.toLowerCase()) return id;
    }
    return null;
  }

  /**
   * Opens the technical cycle, or returns the one already open from a previous
   * attempt. Refuses to touch a vault whose open cycle is not ours.
   */
  private async ensureTechnicalCycle(vaultAddress: Address, raiseCycleId: bigint, rate: bigint): Promise<bigint> {
    const status = await this.vaultStatus(vaultAddress);
    const current = await this.contractReader.currentCycleId(vaultAddress);

    if (status === EvmVaultOnchainStatus.Active) {
      const cycle = await this.contractReader.getCycle(vaultAddress, current);
      if (current > raiseCycleId && this.isTechnical(cycle, rate)) return current;
      throw new Error(`vault ${vaultAddress} has a non-LP cycle ${current} open — refusing to seed LP`);
    }
    if (status !== EvmVaultOnchainStatus.Locked) {
      throw new Error(`vault ${vaultAddress} is ${EvmVaultOnchainStatus[status]}, expected Locked`);
    }

    await this.adminSigner.sendAndConfirm(
      {
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: 'openCycle',
        args: [
          {
            assetWindow: { start: 0n, end: 0n },
            acquireWindow: { start: 0n, end: 0n },
            minAcquireThreshold: 0n,
            adaPairVtPerNativeUnit: rate,
            assetWhitelist: [],
            contributorWhitelist: [],
          },
        ],
      },
      ['CycleOpened']
    );
    return this.contractReader.currentCycleId(vaultAddress);
  }

  /** Close the technical cycle with an empty allocation, if it is still open. */
  private async closeTechnicalCycleIfOpen(vaultAddress: Address, raiseCycleId: bigint): Promise<void> {
    if ((await this.vaultStatus(vaultAddress)) !== EvmVaultOnchainStatus.Active) return;
    const current = await this.contractReader.currentCycleId(vaultAddress);
    const cycle = await this.contractReader.getCycle(vaultAddress, current);
    if (current <= raiseCycleId || cycle.status !== EvmCycleStatus.Active || cycle.nativeCollected !== 0n) {
      throw new Error(`vault ${vaultAddress} cycle ${current} is not an empty LP cycle — not closing`);
    }

    // Nobody contributed: the root commits to nothing and is never claimable.
    const root = lpTechnicalCycleRoot(vaultAddress, current);
    const valuationHash = keccak256(encodePacked(['string', 'bytes32'], ['l4va-lp-no-valuation', root]));
    await this.adminSigner.sendAndConfirm(
      { address: vaultAddress, abi: VAULT_ABI, functionName: 'closeCycle', args: [root, valuationHash, 0n, 0n] },
      ['CycleClosed']
    );
    this.logger.log(`Technical LP cycle ${current} closed for ${vaultAddress}`);
  }

  private isTechnical(cycle: Awaited<ReturnType<EvmContractReader['getCycle']>>, rate: bigint): boolean {
    return (
      cycle.status === EvmCycleStatus.Active &&
      cycle.adaPairVtPerNativeUnit === rate &&
      cycle.assetWindow.end === 0n &&
      cycle.acquireWindow.end === 0n
    );
  }

  private async vaultStatus(vaultAddress: Address): Promise<EvmVaultOnchainStatus> {
    return (await this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'status',
    })) as EvmVaultOnchainStatus;
  }

  private async saveLp(snapshotId: string, lp: EvmLpCarveoutRecord): Promise<void> {
    await this.snapshotsRepository.update({ id: snapshotId }, { lp_carveout: { ...lp } });
  }
}
