import { Injectable, Logger } from '@nestjs/common';

import { Claim } from '@/database/claim.entity';

interface AcquirerTokenParams {
  /** Amount of ADA sent by the acquirer (in ADA, not lovelace) */
  adaSent: number;
  /** Total ADA acquired from all acquirers */
  totalAcquiredValueAda: number;
  /** Amount of VT tokens allocated to liquidity pool */
  lpVtAmount: number;
  /** Amount of ADA allocated to liquidity pool */
  lpAdaAmount: number;
  /** Total supply of vault tokens */
  vtSupply: number;
  /** Percentage of tokens offered to acquirers (0-1) */
  ASSETS_OFFERED_PERCENT: number;
  /** Price per VT token in ADA */
  vtPrice: number;
}

interface AcquirerTokenResult {
  /** Number of VT tokens to be received */
  vtReceived: number;
  /** Multiplier used for on-chain calculation */
  multiplier: number;
}

interface ContributorTokenParams {
  /** Value contributed in this specific transaction (in ADA) */
  txContributedValue: number;
  /** Total value contributed by this user across all transactions */
  userTotalValue: number;
  /** Total value locked (TVL) from all contributors */
  totalTvl: number;
  /** Amount of VT tokens allocated to liquidity pool */
  lpVtAmount: number;
  /** Total ADA acquired from all acquirers */
  totalAcquiredAda: number;
  /** Amount of ADA allocated to liquidity pool */
  lpAdaAmount: number;
  /** Total supply of vault tokens */
  vtSupply: number;
  /** Percentage of tokens offered to acquirers (0-1) */
  ASSETS_OFFERED_PERCENT: number;
}

interface ContributorTokenResult {
  /** Number of VT tokens to be received */
  vtAmount: number;
  /** Amount of ADA to be received (in lovelace) */
  lovelaceAmount: number;
  /** Proportion of this tx within user's total contribution (0-1) */
  proportionOfUserTotal: number;
  /** Total VT tokens the user will receive */
  userTotalVtTokens: number;
}

interface LiquidityPoolParams {
  /** Total ADA acquired from all acquirers */
  totalAcquiredAda: number;
  /** Total supply of vault tokens */
  vtSupply: number;
  /** Percentage of tokens offered to acquirers (0-1) */
  assetsOfferedPercent: number;
  /** Percentage of FDV to allocate to LP (0-1) */
  lpPercent: number;
  /** Total value of contributed assets (fallback FDV if no acquirers) */
  totalContributedValueAda: number;
}

interface LiquidityPoolResult {
  /** Amount of ADA for the liquidity pool */
  lpAdaAmount: number;
  /** Amount of VT tokens for the liquidity pool */
  lpVtAmount: number;
  /** Calculated price per VT token in ADA */
  vtPrice: number;
  /** Fully diluted valuation of the vault */
  fdv: number;
  /** Adjusted VT amount for on-chain LP (using multiplier) */
  adjustedVtLpAmount: number;
  /** Multiplier for on-chain ADA pair calculation */
  adaPairMultiplier: number;
}

interface AcquireMultiplierParams {
  /** Claims from contributors with their asset allocations */
  contributorsClaims: Claim[];
  /** Optional claims from acquirers (empty if 0% acquirer scenario) */
  acquirerClaims?: Claim[];
}

interface AcquireMultiplierResult {
  /** Array of [policyId, assetName, vtAmount] for each asset */
  acquireMultiplier: [string, string, number][];
  /** Array of [policyId, assetName, adaAmount] for each asset */
  adaDistribution: [string, string, number][];
  /** Map of claim ID to recalculated VT amount (qty × multiplier) for smart contract consistency */
  recalculatedClaimAmounts: Map<string, number>;
  /** Map of claim ID to recalculated lovelace amount (qty × ada_multiplier) for smart contract consistency */
  recalculatedLovelaceAmounts: Map<string, number>;
}

/**
 * DistributionCalculationService
 *
 * This service provides core business logic for calculating token and ADA distributions
 * for contributors and acquirers in the vault system. It includes formulas for
 * liquidity pool allocation, VT token pricing, contributor/acquirer shares, and
 * value retention metrics.
 *
 * Edge Cases Handled:
 * - Acquirers % = 0%: Contributors get all tokens, no acquire phase
 * - Acquirers % = 100%: Contributors get only ADA, no VT tokens
 * - LP % = 0%: No liquidity pool, price calculated from FDV/Supply
 * - Combined edge cases (e.g., 0% acquirers + 0% LP)
 */
@Injectable()
export class DistributionCalculationService {
  private readonly logger = new Logger(DistributionCalculationService.name);

  constructor() {}

  calculateAcquirerTokens(params: AcquirerTokenParams): AcquirerTokenResult {
    const { adaSent, vtSupply, ASSETS_OFFERED_PERCENT, totalAcquiredValueAda, lpVtAmount } = params;

    // ((ADA sent to the vault / total acquire ADA) * Assets Offered Percent) * (VT Supply - LP VT)
    const percentOfTotalAcquireAdaSent = this.round25(adaSent / totalAcquiredValueAda);
    const vtReceived = this.round25(percentOfTotalAcquireAdaSent * ASSETS_OFFERED_PERCENT * (vtSupply - lpVtAmount));
    const multiplier = Math.floor(vtReceived / adaSent / 1_000_000);
    const adjustedVtAmount = multiplier * adaSent * 1_000_000;
    return {
      vtReceived: adjustedVtAmount,
      multiplier,
    };
  }
  calculateContributorTokens(params: ContributorTokenParams): ContributorTokenResult {
    const {
      txContributedValue,
      userTotalValue,
      totalTvl,
      lpVtAmount,
      totalAcquiredAda,
      lpAdaAmount,
      vtSupply,
      ASSETS_OFFERED_PERCENT,
    } = params;

    // Calculate proportion of this transaction within user's total contribution
    const proportionOfUserTotal = userTotalValue > 0 ? txContributedValue / userTotalValue : 0;

    // Calculate contributor share of total value
    const contributorShare = totalTvl > 0 ? userTotalValue / totalTvl : 0;

    // Edge Case: If Acquirers = 100% (Contributors = 0%)
    // Contributors get NO VT, but receive ALL ADA (minus LP)
    let userTotalVtTokens: number;
    let vtAmount: number;

    if (ASSETS_OFFERED_PERCENT >= 1.0) {
      // All tokens go to acquirers, contributors get 0 VT
      userTotalVtTokens = 0;
      vtAmount = 0;

      this.logger.log(`Contributors get 0 VT (Acquirers = 100%). ` + `They will receive ADA only.`);
    } else {
      // Normal calculation: Contributors get VT based on their share
      userTotalVtTokens = this.round25((vtSupply - lpVtAmount) * (1 - ASSETS_OFFERED_PERCENT) * contributorShare);
      vtAmount = userTotalVtTokens * proportionOfUserTotal;
    }

    // Calculate ADA distribution
    // Contributors receive ADA from acquirers (minus LP allocation)
    const adaForContributors = totalAcquiredAda - lpAdaAmount;
    const userAdaShare = contributorShare * adaForContributors;
    const adaAmount = userAdaShare * proportionOfUserTotal;

    return {
      vtAmount: Math.floor(vtAmount),
      lovelaceAmount: Math.floor(adaAmount * 1_000_000), // Convert to lovelace
      proportionOfUserTotal,
      userTotalVtTokens: Math.round(userTotalVtTokens),
    };
  }

  /**
   * Calculate liquidity pool tokens and values
   *
   * Edge cases handled:
   * - Acquirers % = 0%: Use TVL as FDV, no acquire phase
   * - LP % = 0%: No liquidity pool, calculate token price from FDV/Supply
   * - Both can be 0% simultaneously
   */
  calculateLpTokens(params: LiquidityPoolParams): LiquidityPoolResult {
    const { totalAcquiredAda, assetsOfferedPercent, lpPercent, vtSupply, totalContributedValueAda } = params;

    let fdv: number;

    // Edge Case 1: No acquirers (Acquirers % = 0%)
    if (assetsOfferedPercent === 0) {
      // Use TVL of contributed assets as FDV
      fdv = totalContributedValueAda;

      this.logger.log(
        `No acquirers scenario: Using TVL (${totalContributedValueAda} ADA) as FDV. ` + `No acquire phase will occur.`
      );

      // If also no LP, return zero values with calculated token price
      if (lpPercent === 0 || fdv === 0) {
        const vtPrice = fdv > 0 ? this.round25(fdv / vtSupply) : 0;

        this.logger.log(`No LP scenario: VT price = ${vtPrice} ADA (FDV ${fdv} / Supply ${vtSupply})`);

        return {
          lpAdaAmount: 0,
          lpVtAmount: 0,
          vtPrice,
          fdv,
          adjustedVtLpAmount: 0,
          adaPairMultiplier: 0,
        };
      }

      // If LP exists with 0% acquirers, calculate LP from TVL
      // LP can only exist if ADA was contributed as an asset
    } else {
      // Normal FDV calculation: Total ADA from acquirers / % tokens offered
      fdv = this.round2(totalAcquiredAda / assetsOfferedPercent);
    }

    // Edge Case 2: No liquidity pool (LP % = 0%)
    if (lpPercent === 0) {
      const vtPrice = this.round25(fdv / vtSupply);

      this.logger.log(
        `No LP scenario: VT price calculated from FDV: ${vtPrice} ADA ` + `(FDV ${fdv} / Supply ${vtSupply})`
      );

      return {
        lpAdaAmount: 0,
        lpVtAmount: 0,
        vtPrice,
        fdv,
        adjustedVtLpAmount: 0,
        adaPairMultiplier: 0,
      };
    }

    // Normal LP calculation
    // LP % is a percentage of the FDV VALUE, split equally between ADA and VT
    const lpAdaAmount = Math.round(((lpPercent * fdv) / 2) * 1e6) / 1e6;
    const lpVtValue = this.round25((lpPercent * vtSupply) / 2);

    // Calculate token price: LP ADA / LP VT
    const vtPrice = lpVtValue > 0 ? this.round25(lpAdaAmount / lpVtValue) : 0;

    // Calculate multiplier for on-chain representation
    const adaPairMultiplier = totalAcquiredAda > 0 ? Math.floor(lpVtValue / (totalAcquiredAda * 1_000_000)) : 0;
    const adjustedVtLpAmount = adaPairMultiplier * totalAcquiredAda * 1_000_000;

    return {
      lpAdaAmount,
      lpVtAmount: lpVtValue,
      vtPrice,
      fdv,
      adjustedVtLpAmount,
      adaPairMultiplier,
    };
  }

  calculateAcquireMultipliers(params: AcquireMultiplierParams): AcquireMultiplierResult {
    const { contributorsClaims, acquirerClaims } = params;

    const acquireMultiplier = [];
    const adaDistribution = [];
    const recalculatedClaimAmounts = new Map<string, number>();
    const recalculatedLovelaceAmounts = new Map<string, number>();

    for (const claim of contributorsClaims) {
      const contributorLovelaceAmount = claim?.lovelace_amount || 0;

      // VT token distribution (existing logic)
      const baseVtShare = Math.floor(claim.amount / claim.transaction.assets.length);
      const vtRemainder = claim.amount - baseVtShare * claim.transaction.assets.length;

      // ADA distribution among assets
      const baseAdaShare = Math.floor(contributorLovelaceAmount / claim.transaction.assets.length);
      const adaRemainder = contributorLovelaceAmount - baseAdaShare * claim.transaction.assets.length;

      // Track recalculated amounts for this claim (qty × multiplier)
      let recalculatedVtAmount = 0;
      let recalculatedLovelace = 0;

      claim.transaction.assets.forEach((asset, index) => {
        const vtShare = baseVtShare + (index < vtRemainder ? 1 : 0);
        // Divide by asset quantity to get per-unit multiplier
        // Smart contract calculates: expected = multiplier * quantity_on_utxo
        const assetQuantity = Number(asset.quantity) || 1;
        const vtSharePerUnit = Math.floor(vtShare / assetQuantity);
        acquireMultiplier.push([asset.policy_id, asset.asset_id, vtSharePerUnit]);

        // Recalculate VT amount using the same formula as smart contract: qty × multiplier
        recalculatedVtAmount += assetQuantity * vtSharePerUnit;

        const adaShare = baseAdaShare + (index < adaRemainder ? 1 : 0);
        const adaSharePerUnit = Math.floor(adaShare / assetQuantity);
        adaDistribution.push([asset.policy_id, asset.asset_id, adaSharePerUnit]);

        // Recalculate lovelace amount using the same formula as smart contract
        recalculatedLovelace += assetQuantity * adaSharePerUnit;
      });

      // Store the recalculated amounts (these will match smart contract validation exactly)
      recalculatedClaimAmounts.set(claim.id, recalculatedVtAmount);
      recalculatedLovelaceAmounts.set(claim.id, recalculatedLovelace);
    }

    if (!acquirerClaims || acquirerClaims.length === 0) {
      return {
        acquireMultiplier,
        adaDistribution,
        recalculatedClaimAmounts,
        recalculatedLovelaceAmounts,
      };
    }

    const multiplier =
      acquirerClaims[0].multiplier ||
      Math.floor(acquirerClaims[0].amount / acquirerClaims[0].transaction.amount / 1_000_000);
    acquireMultiplier.push(['', '', multiplier]);

    return {
      acquireMultiplier,
      adaDistribution,
      recalculatedClaimAmounts,
      recalculatedLovelaceAmounts,
    };
  }

  /**
   * Calculate optimal decimals for vault tokens based on token supply and multipliers.
   *
   * The decimals need to ensure:
   * 1. vtSupply * 10^decimals fits in JavaScript's safe integer range
   * 2. Multiplier calculations don't overflow (upper bound)
   * 3. Multipliers don't underflow to 0 (lower bound) - by increasing decimals
   * 4. Sufficient precision for token distributions
   *
   * Key insight for underflow prevention:
   * - If minMultiplier = 0.74 with 6 decimals, it floors to 0 (bad!)
   * - Increasing to 7 decimals: 0.74 * 10 = 7.4, floors to 7 (good!)
   * - Extra decimals needed = ceil(-log10(minMultiplier))
   *
   * @param tokenSupply - The token supply (not scaled by decimals)
   * @param maxMultiplier - Optional maximum multiplier value from acquire_multiplier array
   * @param minMultiplier - Optional minimum multiplier value (to prevent underflow to 0)
   * @returns Optimal number of decimals (0-8)
   */
  calculateOptimalDecimals(tokenSupply: number, maxMultiplier?: number, minMultiplier?: number): number {
    const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 9,007,199,254,740,991
    const MIN_VALID_MULTIPLIER = 1; // Minimum multiplier to ensure users get tokens
    const MAX_DECIMALS = 8; // Absolute maximum decimals allowed

    // Calculate max safe decimals based on token supply alone
    const maxSafeDecimalsFromSupply = Math.floor(Math.log10(MAX_SAFE / tokenSupply));

    // If we have multiplier data, also consider that for overflow prevention
    let maxSafeDecimalsFromMultiplier = 15; // Default to high value if no multiplier
    if (maxMultiplier && maxMultiplier > 0) {
      // Multipliers are stored as integers representing the ratio
      // We need to ensure qty * multiplier fits in safe range
      // Assume max quantity per asset is ~1000 (conservative for NFTs)
      const assumedMaxQuantity = 1000;
      maxSafeDecimalsFromMultiplier = Math.floor(Math.log10(MAX_SAFE / (maxMultiplier * assumedMaxQuantity)));
    }

    // Calculate minimum decimals needed to prevent underflow (multiplier < 1 flooring to 0)
    let minDecimalsForUnderflow = 0;
    if (minMultiplier !== undefined && minMultiplier > 0 && minMultiplier < MIN_VALID_MULTIPLIER) {
      // We need to increase decimals so that minMultiplier * 10^extraDecimals >= 1
      // extraDecimals >= -log10(minMultiplier)
      // Example: minMultiplier = 0.74 → extraDecimals >= 0.13 → need 1 extra decimal
      // Example: minMultiplier = 0.01 → extraDecimals >= 2 → need 2 extra decimals
      const extraDecimalsNeeded = Math.ceil(-Math.log10(minMultiplier));
      minDecimalsForUnderflow = extraDecimalsNeeded;

      this.logger.warn(
        `Multiplier underflow detected: minMultiplier=${minMultiplier.toFixed(4)}. ` +
          `Increasing decimals by ${extraDecimalsNeeded} to prevent 0 token distributions.`
      );
    }

    // Take the minimum of overflow constraints
    const maxSafeDecimals = Math.min(maxSafeDecimalsFromSupply, maxSafeDecimalsFromMultiplier);

    // Determine target decimals based on token supply tiers
    let targetDecimals: number;
    if (tokenSupply >= 900_000_000_000) {
      targetDecimals = 1;
    } else if (tokenSupply >= 90_000_000_000) {
      targetDecimals = 1;
    } else if (tokenSupply >= 9_000_000_000) {
      targetDecimals = 2;
    } else if (tokenSupply >= 900_000_000) {
      targetDecimals = 3;
    } else if (tokenSupply >= 90_000_000) {
      targetDecimals = 4;
    } else if (tokenSupply >= 9_000_000) {
      targetDecimals = 5;
    } else if (tokenSupply >= 1_000_000) {
      targetDecimals = 6;
    } else {
      targetDecimals = 6;
    }

    // Apply underflow prevention: increase decimals if needed
    const decimalsWithUnderflowPrevention = Math.max(targetDecimals, targetDecimals + minDecimalsForUnderflow);

    // Apply overflow safety: cap at max safe decimals
    const finalDecimals = Math.min(decimalsWithUnderflowPrevention, maxSafeDecimals, MAX_DECIMALS);

    // Check if we couldn't prevent underflow due to overflow constraints
    if (minDecimalsForUnderflow > 0 && finalDecimals < targetDecimals + minDecimalsForUnderflow) {
      this.logger.error(
        `CRITICAL: Cannot fully prevent multiplier underflow! ` +
          `Need ${targetDecimals + minDecimalsForUnderflow} decimals but capped at ${finalDecimals} for overflow safety. ` +
          `minMultiplier: ${minMultiplier?.toFixed(4)}, maxMultiplier: ${maxMultiplier || 'N/A'}, tokenSupply: ${tokenSupply}. ` +
          `Some users may receive 0 tokens. Consider reducing token supply.`
      );
    }

    if (finalDecimals < targetDecimals) {
      this.logger.warn(
        `Token supply ${tokenSupply}: target decimals ${targetDecimals} reduced to ${finalDecimals} for overflow safety ` +
          `(maxMultiplier: ${maxMultiplier || 'N/A'})`
      );
    } else if (finalDecimals > targetDecimals) {
      this.logger.log(
        `Token supply ${tokenSupply}: decimals increased from ${targetDecimals} to ${finalDecimals} to prevent underflow ` +
          `(minMultiplier: ${minMultiplier?.toFixed(4)})`
      );
    }

    // Database constraint requires decimals between 1 and 9, never return 0
    return Math.max(finalDecimals, 1);
  }

  private round25(amount: number): number {
    return Math.round(amount * 1e25) / 1e25;
  }

  protected round2(amount: number): number {
    return Math.round(amount * 1e2) / 1e2;
  }
}
