import { encodePacked, isAddress, keccak256, type Address, type Hex } from 'viem';

/**
 * Post-close LP seeding for EVM vaults.
 *
 *   EVM_LP_ENABLED=true
 *   EVM_LP_ADAPTER_ADDRESS=0x...   UniswapV4LiquidityAdapter (default) or UniswapV2LiquidityAdapter,
 *                                  approved on the AdapterRegistry. The venue follows the
 *                                  adapter's protocol tag.
 *   EVM_LP_MAX_PRICE_DEVIATION_BPS (optional, default 30) — revert if the pool already
 *                                  trades more than this away from the vault's price. On v4
 *                                  it is also the most of an input a deposit may forfeit.
 *   EVM_LP_V4_FEE / EVM_LP_V4_TICK_SPACING (optional, default 10000 / 200) — v4 fee tier.
 *
 * Everything else (V2 factory/WETH, v4 PoolManager/PositionManager) is read from the adapter.
 */
export function getEvmLpAdapterAddress(): Address | null {
  if ((process.env.EVM_LP_ENABLED ?? '').trim().toLowerCase() !== 'true') return null;
  const raw = (process.env.EVM_LP_ADAPTER_ADDRESS ?? '').trim();
  return isAddress(raw) ? (raw as Address) : null;
}

export function getEvmLpMaxPriceDeviationBps(): number {
  const n = Number(process.env.EVM_LP_MAX_PRICE_DEVIATION_BPS ?? '30');
  return Number.isInteger(n) && n >= 0 && n <= 10_000 ? n : 30;
}

/**
 * v4 fee tiers to try, in order. If someone initialized the vault's pool for a
 * tier at another price (v4 pools initialize once), the next tier is used.
 */
export function getEvmLpV4PoolCandidates(): Array<{ fee: number; tickSpacing: number }> {
  const primary = getEvmLpV4PoolConfig();
  const fallbacks = [
    { fee: 10_000, tickSpacing: 200 },
    { fee: 10_000, tickSpacing: 100 },
    { fee: 3_000, tickSpacing: 60 },
    { fee: 30_000, tickSpacing: 600 },
  ];
  return [primary, ...fallbacks.filter(f => f.fee !== primary.fee || f.tickSpacing !== primary.tickSpacing)];
}

/**
 * Allocation root of the empty technical cycle EvmLiquidityService opens to seed
 * LP. Deterministic so the event reconciler can recognize the cycle as ours.
 */
export function lpTechnicalCycleRoot(vaultAddress: Address, cycleId: bigint): Hex {
  return keccak256(encodePacked(['string', 'address', 'uint256'], ['l4va-lp-technical-cycle', vaultAddress, cycleId]));
}

/** v4 fee tier for new vault pools: 1% / tick spacing 200 unless overridden. */
export function getEvmLpV4PoolConfig(): { fee: number; tickSpacing: number } {
  const fee = Number(process.env.EVM_LP_V4_FEE ?? '10000');
  const tickSpacing = Number(process.env.EVM_LP_V4_TICK_SPACING ?? '200');
  return {
    fee: Number.isInteger(fee) && fee > 0 && fee < 1_000_000 ? fee : 10_000,
    tickSpacing: Number.isInteger(tickSpacing) && tickSpacing > 0 && tickSpacing <= 32_767 ? tickSpacing : 200,
  };
}

/** `snapshot.lp_carveout` payload. Amounts are decimal strings (bigint). */
export interface EvmLpCarveoutRecord {
  status: EvmLpStatus;
  lpBps: number;
  lpVtAmount: string;
  lpNativeAmount: string;
  rate: string;
  fdvNative: string;
  adapter: string;
  protocol?: 'uniswap-v2' | 'uniswap-v4';
  /** V2 pair (= LP token). */
  pair?: string;
  /** v4 pool id. */
  poolId?: string;
  technicalCycleId?: string;
  lpPositionId?: string;
  lpTokens?: string;
  provideTxHash?: string;
  attempts?: number;
  lastError?: string;
}

export enum EvmLpStatus {
  /** Carved out of the allocation; waiting for the main cycle to close. */
  pending = 'pending',
  /** Pool seeded and the technical cycle closed. */
  provided = 'provided',
  /** Gave up after repeated failures — needs an operator. */
  failed = 'failed',
}
