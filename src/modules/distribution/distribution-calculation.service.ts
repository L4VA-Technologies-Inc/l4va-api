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

    for (const claim of contributorsClaims) {
      const contributorLovelaceAmount = claim?.lovelace_amount || 0;

      // VT token distribution (existing logic)
      const baseVtShare = Math.floor(claim.amount / claim.transaction.assets.length);
      const vtRemainder = claim.amount - baseVtShare * claim.transaction.assets.length;

      // ADA distribution among assets
      const baseAdaShare = Math.floor(contributorLovelaceAmount / claim.transaction.assets.length);
      const adaRemainder = contributorLovelaceAmount - baseAdaShare * claim.transaction.assets.length;

      claim.transaction.assets.forEach((asset, index) => {
        const vtShare = baseVtShare + (index < vtRemainder ? 1 : 0);
        // Divide by asset quantity to get per-unit multiplier
        // Smart contract calculates: expected = multiplier * quantity_on_utxo
        const assetQuantity = Number(asset.quantity) || 1;
        const vtSharePerUnit = Math.floor(vtShare / assetQuantity);
        acquireMultiplier.push([asset.policy_id, asset.asset_id, vtSharePerUnit]);

        const adaShare = baseAdaShare + (index < adaRemainder ? 1 : 0);
        const adaSharePerUnit = Math.floor(adaShare / assetQuantity);
        adaDistribution.push([asset.policy_id, asset.asset_id, adaSharePerUnit]);
      });
    }

    if (!acquirerClaims || acquirerClaims.length === 0) {
      return {
        acquireMultiplier,
        adaDistribution,
      };
    }

    const multiplier =
      acquirerClaims[0].multiplier ||
      Math.floor(acquirerClaims[0].amount / acquirerClaims[0].transaction.amount / 1_000_000);
    acquireMultiplier.push(['', '', multiplier]);

    return {
      acquireMultiplier,
      adaDistribution,
    };
  }

  private round25(amount: number): number {
    return Math.round(amount * 1e25) / 1e25;
  }

  protected round2(amount: number): number {
    return Math.round(amount * 1e2) / 1e2;
  }
}
