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
import { EvmCycleStatus, EvmVaultOnchainStatus, VAULT_ABI } from './vault.abi';

import { EvmSnapshotStatus, EvmValuationSnapshot } from '@/database/evm-valuation-snapshot.entity';
import { Vault } from '@/database/vault.entity';
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

const V4_POSITION_MANAGER_ABI = [
  {
    type: 'function',
    stateMutability: 'view',
    name: 'getPositionLiquidity',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'uint128' }],
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
const Q96 = 2n ** 96n;

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

  constructor(
    @InjectRepository(Vault) private readonly vaultsRepository: Repository<Vault>,
    @InjectRepository(EvmValuationSnapshot) private readonly snapshotsRepository: Repository<EvmValuationSnapshot>,
    private readonly contractReader: EvmContractReader,
    private readonly adminSigner: EvmAdminSigner
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
      await this.provideForSnapshot(snap.id).catch(err =>
        this.logger.error(`LP for snapshot ${snap.id} failed: ${(err as Error).message}`)
      );
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
    };
  }

  /**
   * v4 pool view. Every vault position is full range, so its token amounts are
   *   native = L · Q96 / sqrtP,   VT = L · sqrtP / Q96
   * (the range edges are far enough to ignore). Pool totals use the pool's
   * in-range liquidity, which is exact as long as LPs stay full range.
   */
  private async getV4View(
    base: EvmVaultLpView,
    lp: EvmLpCarveoutRecord,
    vaultAddress: Address
  ): Promise<EvmVaultLpView> {
    const client = this.contractReader.publicClient;
    const adapter = lp.adapter as Address;
    const poolId = lp.poolId as Hex;
    const [positionManager, stateView, ids, vt] = (await Promise.all([
      client.readContract({ address: adapter, abi: LP_ADAPTER_ABI, functionName: 'positionManager' }),
      client.readContract({ address: adapter, abi: LP_ADAPTER_ABI, functionName: 'stateView' }),
      client.readContract({ address: adapter, abi: LP_ADAPTER_ABI, functionName: 'positionsOf', args: [vaultAddress] }),
      client.readContract({ address: vaultAddress, abi: VAULT_ABI, functionName: 'vaultToken' }),
    ])) as [Address, Address, readonly bigint[], Address];

    const [slot0, poolLiquidity, vtDecimals, ...positionLiquidity] = (await Promise.all([
      client.readContract({ address: stateView, abi: V4_STATE_VIEW_ABI, functionName: 'getSlot0', args: [poolId] }),
      client.readContract({ address: stateView, abi: V4_STATE_VIEW_ABI, functionName: 'getLiquidity', args: [poolId] }),
      client.readContract({ address: vt, abi: V2_PAIR_ABI, functionName: 'decimals' }),
      ...ids.map(id =>
        client.readContract({
          address: positionManager,
          abi: V4_POSITION_MANAGER_ABI,
          functionName: 'getPositionLiquidity',
          args: [id],
        })
      ),
    ])) as [readonly [bigint, number, number, number], bigint, number, ...bigint[]];

    const sqrtP = slot0[0];
    const vaultLiquidity = positionLiquidity.reduce((sum, l) => sum + l, 0n);
    const decimals = Number(vtDecimals);
    const reserveNative = sqrtP > 0n ? formatUnits((poolLiquidity * Q96) / sqrtP, 18) : '0';
    const reserveVt = formatUnits((poolLiquidity * sqrtP) / Q96, decimals);
    // price (VT per native, raw) = sqrtP² / 2^192 → native per whole VT:
    const vtPriceNative =
      sqrtP > 0n ? (Number((2n ** 192n * 10n ** BigInt(decimals)) / (sqrtP * sqrtP)) / 1e18).toString() : null;

    return {
      ...base,
      protocol: 'uniswap-v4',
      positionManager,
      positionIds: ids.map(id => id.toString()),
      vaultToken: vt,
      reserveVt,
      reserveNative,
      vtPriceNative,
      vaultLpTokens: vaultLiquidity.toString(),
      lpTotalSupply: poolLiquidity.toString(),
      vaultSharePct: poolLiquidity > 0n ? Number((vaultLiquidity * 1_000_000n) / poolLiquidity) / 10_000 : null,
    };
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
        await this.closeTechnicalCycleIfOpen(vaultAddress, raiseCycleId).catch(closeErr =>
          this.logger.error(
            `LP failed for vault ${vault.id} and its technical cycle could not be closed: ${(closeErr as Error).message}`
          )
        );
      }
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
