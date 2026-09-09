import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { erc20Abi, type Address } from 'viem';

import { EvmContractReader } from './evm-contract-reader.service';
import { VAULT_ABI } from './vault.abi';

import { SystemSettingsService } from '@/modules/globals/system-settings/system-settings.service';

/**
 * Liquidity preflight for EVM vault termination.
 *
 * This is an OPERATIONAL policy, not a safety mechanism. Contract solvency does
 * not depend on it: `Vault.sol` caps every redemption rate at the asset's free
 * balance and denominates against `totalSupply()`, so every unit of VT is
 * funded wherever it sits — including inside an AMM pair, and including a
 * wallet that buys it out of that pair mid-window. The check must survive being
 * bypassed, misconfigured, or invalidated by pool movement afterwards.
 *
 * What it actually guards is wind-down QUALITY. There is no LP removal path in
 * the contract (`LiquidityPositionStatus.Closed` exists but is never assigned,
 * and `IVaultAdapter` has no removal surface), so a vault with meaningful
 * protocol-owned liquidity distributes LP tokens whose VT side is dying. This
 * blocks that case until LP removal ships.
 */

/** Where the pool exposure figure came from. Only `failed` blocks. */
export enum PoolDiscoveryOutcome {
  /** Query succeeded and the VT has no pools. Ratio is genuinely zero. */
  VerifiedNoPools = 'verified_no_pools',
  /** Query succeeded and pairs were found; balances were read. */
  VerifiedWithPools = 'verified_with_pools',
  /** Query failed, timed out, or returned partial data. Exposure is unknown. */
  Failed = 'failed',
}

export interface PoolDiscoveryResult {
  outcome: PoolDiscoveryOutcome;
  pairs: Address[];
  /** Sum of VT held across every discovered pair, in base units. */
  poolHeldVt: bigint;
  totalSupply: bigint;
  /** `poolHeldVt / totalSupply` in bips. Zero when there are no pools. */
  poolVtBps: bigint;
  checkedAt: Date;
  error?: string;
}

export interface LpPositionSummary {
  activeCount: number;
  /** Distinct `positionAsset` addresses across active LP positions. */
  positionAssets: Address[];
}

export interface TerminationPreflightResult {
  ok: boolean;
  /** Human-readable reasons the vault is blocked. Empty when `ok`. */
  blockers: string[];
  discovery: PoolDiscoveryResult;
  lp: LpPositionSummary;
  thresholdBps: bigint;
}

const ZERO = '0x0000000000000000000000000000000000000000' as const;

@Injectable()
export class EvmTerminationPreflightService {
  private readonly logger = new Logger(EvmTerminationPreflightService.name);
  private readonly dexScreenerChainId: string;

  constructor(
    private readonly contractReader: EvmContractReader,
    private readonly systemSettings: SystemSettingsService,
    configService: ConfigService
  ) {
    this.dexScreenerChainId = configService.get<string>('DEXSCREENER_CHAIN_ID') ?? 'robinhood';
  }

  /**
   * Discover every pool holding the vault's VT and sum the VT sitting in them.
   *
   * Deliberately does NOT reuse `PriceService.getDexScreenerMarkets`: that
   * helper swallows request failures into a warning and returns only the single
   * deepest pair. Both behaviours are wrong here — a swallowed failure would be
   * indistinguishable from "no pools", which would silently pass a vault whose
   * exposure is unknown, and summing requires every pair, not the best one.
   */
  async discoverPools(vtAddress: Address): Promise<PoolDiscoveryResult> {
    const checkedAt = new Date();

    let totalSupply: bigint;
    try {
      totalSupply = (await this.contractReader.publicClient.readContract({
        address: vtAddress,
        abi: erc20Abi,
        functionName: 'totalSupply',
      })) as bigint;
    } catch (err) {
      return {
        outcome: PoolDiscoveryOutcome.Failed,
        pairs: [],
        poolHeldVt: 0n,
        totalSupply: 0n,
        poolVtBps: 0n,
        checkedAt,
        error: `could not read VT totalSupply: ${(err as Error).message}`,
      };
    }

    let pairs: Address[];
    try {
      const url = `https://api.dexscreener.com/tokens/v1/${this.dexScreenerChainId}/${vtAddress}`;
      const response = await axios.get(url, { timeout: 10_000 });
      const raw: any[] = Array.isArray(response.data) ? response.data : [];
      const target = vtAddress.toLowerCase();
      pairs = raw
        .filter(p => p.baseToken?.address?.toLowerCase() === target || p.quoteToken?.address?.toLowerCase() === target)
        .map(p => p.pairAddress)
        .filter((a: unknown): a is Address => typeof a === 'string' && a.startsWith('0x'));
    } catch (err) {
      // Unknown exposure. This blocks — it must never be mistaken for "no pools".
      return {
        outcome: PoolDiscoveryOutcome.Failed,
        pairs: [],
        poolHeldVt: 0n,
        totalSupply,
        poolVtBps: 0n,
        checkedAt,
        error: `pool discovery failed: ${(err as Error).message}`,
      };
    }

    if (pairs.length === 0) {
      // A verified absence. Most vaults never list their VT, so treating this
      // as a failure would block nearly everything.
      return {
        outcome: PoolDiscoveryOutcome.VerifiedNoPools,
        pairs: [],
        poolHeldVt: 0n,
        totalSupply,
        poolVtBps: 0n,
        checkedAt,
      };
    }

    let poolHeldVt = 0n;
    for (const pair of pairs) {
      try {
        const bal = (await this.contractReader.publicClient.readContract({
          address: vtAddress,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [pair],
        })) as bigint;
        poolHeldVt += bal;
      } catch (err) {
        // Partial data is unusable: a missing pair understates exposure, which
        // is exactly the direction that would wrongly let a vault through.
        return {
          outcome: PoolDiscoveryOutcome.Failed,
          pairs,
          poolHeldVt: 0n,
          totalSupply,
          poolVtBps: 0n,
          checkedAt,
          error: `balanceOf failed for pair ${pair}: ${(err as Error).message}`,
        };
      }
    }

    const poolVtBps = totalSupply > 0n ? (poolHeldVt * 10_000n) / totalSupply : 0n;
    return {
      outcome: PoolDiscoveryOutcome.VerifiedWithPools,
      pairs,
      poolHeldVt,
      totalSupply,
      poolVtBps,
      checkedAt,
    };
  }

  /**
   * Vault-owned LP positions, read straight from the contract. There is no
   * backend table for these — `evm_external_positions` tracks
   * `openPosition`/`closePosition` only.
   */
  async summarizeLpPositions(vaultAddress: Address): Promise<LpPositionSummary> {
    const total = (await this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'totalLiquidityPositions',
    })) as bigint;

    const positionAssets = new Set<string>();
    let activeCount = 0;

    for (let i = 1n; i <= total; i++) {
      const p = (await this.contractReader.publicClient.readContract({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: 'getLiquidityPosition',
        args: [i],
      })) as { positionAsset: Address; status: number };

      if (p.status === 0 /* Active */) {
        activeCount++;
        positionAssets.add(p.positionAsset.toLowerCase());
      }
    }

    return { activeCount, positionAssets: [...positionAssets] as Address[] };
  }

  /**
   * Run the full check.
   *
   * @param strict `true` before `beginTerminationPreparing` — a refusal is safe
   *        there, because the vault has not yet entered the one-way door.
   *        `false` before `beginTermination`, where the result is advisory:
   *        `TerminationPreparing` has no exit other than `beginTermination`
   *        (`openCycle` accepts only Locked/Cancelled), so a hard block at that
   *        point would brick the vault rather than delay it. Callers must
   *        surface the blockers and allow an explicit operator override.
   */
  async check(vaultAddress: Address, strict: boolean): Promise<TerminationPreflightResult> {
    const thresholdBps = BigInt(this.systemSettings.evmTerminationMaxPoolVtBps);
    const blockers: string[] = [];

    const vtAddress = (await this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'vaultToken',
    })) as Address;

    const discovery = await this.discoverPools(vtAddress);
    const lp = await this.summarizeLpPositions(vaultAddress);

    switch (discovery.outcome) {
      case PoolDiscoveryOutcome.Failed:
        blockers.push(`pool exposure unknown — ${discovery.error ?? 'discovery failed'}`);
        break;
      case PoolDiscoveryOutcome.VerifiedWithPools:
        if (discovery.poolVtBps > thresholdBps) {
          blockers.push(
            `pool-held VT is ${discovery.poolVtBps} bps of supply across ${discovery.pairs.length} pair(s), ` +
              `above the ${thresholdBps} bps threshold. LP removal is not implemented, so those holders would ` +
              `receive LP tokens whose VT side is dying.`
          );
        }
        break;
      case PoolDiscoveryOutcome.VerifiedNoPools:
        break;
    }

    if (lp.activeCount > 0) {
      // Not automatically fatal: an LP token is an ordinary ERC-20 in custody
      // and IS distributable. It is recorded so the operator sees what holders
      // will actually receive, and so the asset can never be silently waived.
      this.logger.warn(
        `Vault ${vaultAddress} has ${lp.activeCount} active LP position(s); ` +
          `their position assets must be committed as distributable: ${lp.positionAssets.join(', ')}`
      );
    }

    const staleAfter = this.systemSettings.evmTerminationPoolDataMaxAgeSeconds;
    const ageSeconds = (Date.now() - discovery.checkedAt.getTime()) / 1000;
    if (ageSeconds > staleAfter) {
      blockers.push(`pool data is ${Math.round(ageSeconds)}s old, older than the ${staleAfter}s limit`);
    }

    const ok = blockers.length === 0;
    if (!ok && !strict) {
      this.logger.warn(
        `Vault ${vaultAddress} failed the pre-commit preflight but is already in TerminationPreparing; ` +
          `blockers: ${blockers.join('; ')}`
      );
    }

    return { ok, blockers, discovery, lp, thresholdBps };
  }

  /** Convenience for callers that only need native/ERC-20 asset addresses. */
  static isNative(asset: Address): boolean {
    return asset.toLowerCase() === ZERO;
  }
}
