import { Injectable, Logger } from '@nestjs/common';

import { Claim } from '@/database/claim.entity';

/**
 * DistributionService
 *
 * This service provides core business logic for calculating token and ADA distributions
 * for contributors and acquirers in the vault system. It includes formulas for
 * liquidity pool allocation, VT token pricing, contributor/acquirer shares, and
 * value retention metrics.
 */
@Injectable()
export class DistributionService {
  private readonly logger = new Logger(DistributionService.name);

  constructor() {}

  calculateAcquirerTokens(params: {
    adaSent: number;
    totalAcquiredValueAda: number;
    lpVtAmount: number;
    lpAdaAmount: number;
    vtSupply: number;
    ASSETS_OFFERED_PERCENT: number;
    vtPrice: number;
  }): {
    vtReceived: number;
    multiplier: number;
  } {
    const { adaSent, vtSupply, ASSETS_OFFERED_PERCENT, totalAcquiredValueAda, lpVtAmount } = params;

    // ((ADA sent to the vault / total acquire ADA) * Assets Offered Percent) * (VT Supply - LP VT)
    const percentOfTotalAcquireAdaSent = this.round15(adaSent / totalAcquiredValueAda);
    const vtReceived = this.round15(percentOfTotalAcquireAdaSent * ASSETS_OFFERED_PERCENT * (vtSupply - lpVtAmount));
    const multiplier = Math.floor(vtReceived / adaSent / 1_000_000);
    const adjustedVtAmount = multiplier * adaSent * 1_000_000;
    return {
      vtReceived: adjustedVtAmount,
      multiplier,
    };
  }

  calculateContributorTokens({
    txContributedValue,
    userTotalValue,
    totalTvl,
    lpVtAmount,
    totalAcquiredAda,
    lpAdaAmount,
    vtSupply,
    ASSETS_OFFERED_PERCENT,
  }: {
    txContributedValue: number;
    userTotalValue: number;
    totalTvl: number;
    lpVtAmount: number;
    lpAdaAmount: number;
    vtSupply: number;
    ASSETS_OFFERED_PERCENT: number;
    totalAcquiredAda: number;
  }): {
    vtAmount: number;
    adaAmount: number;
    proportionOfUserTotal: number;
    userTotalVtTokens: number;
  } {
    // Calculate proportion of this transaction within user's total contribution
    const proportionOfUserTotal = userTotalValue > 0 ? txContributedValue / userTotalValue : 0;

    // Calculate total VT tokens for the user
    const contributorShare = userTotalValue / totalTvl;
    const userTotalVtTokens = this.round15((vtSupply - lpVtAmount) * (1 - ASSETS_OFFERED_PERCENT) * contributorShare);

    // Calculate VT tokens for this specific transaction
    const vtAmount = userTotalVtTokens * proportionOfUserTotal;

    const adaForContributors = totalAcquiredAda - lpAdaAmount;
    const userAdaShare = contributorShare * adaForContributors;
    const adaAmount = userAdaShare * proportionOfUserTotal;

    return {
      vtAmount: Math.floor(vtAmount),
      adaAmount: Math.floor(adaAmount * 1_000_000), // Convert to lovelace
      proportionOfUserTotal,
      userTotalVtTokens: Math.round(userTotalVtTokens),
    };
  }

  /**
   * Calculate liquidity pool tokens and values
   */
  calculateLpTokens(params: {
    totalAcquiredAda: number;
    vtSupply: number;
    assetsOfferedPercent: number;
    lpPercent: number;
  }): {
    lpAdaAmount: number;
    lpVtAmount: number;
    vtPrice: number;
    fdv: number;
  } {
    const { totalAcquiredAda, vtSupply, assetsOfferedPercent, lpPercent } = params;

    // Calculate VT price (this part is correct in your current code)
    const vtPrice = this.round15(totalAcquiredAda / assetsOfferedPercent / vtSupply);

    const fdv = this.round2(totalAcquiredAda / assetsOfferedPercent);

    // LP gets lpPercent of the total vault value
    const lpTotalValue = this.round15(fdv * lpPercent);

    // Divide equally between ADA and VT
    const lpAdaAmount = this.round15(lpTotalValue / 2);
    const lpVtValue = this.round15(lpTotalValue / 2);

    // Convert VT value to tokens
    const lpVtAmount = Math.round(lpVtValue / vtPrice);

    return {
      lpAdaAmount,
      lpVtAmount,
      vtPrice,
      fdv,
    };
  }

  calculateAcquireMultipliers(params: { contributorsClaims: Claim[]; acquirerClaims: Claim[] }): {
    acquireMultiplier: [string, string, number][];
    adaDistribution: [string, string, number][];
  } {
    const { contributorsClaims, acquirerClaims } = params;
    const acquireMultiplier = [];
    const adaDistribution = [];

    for (const claim of contributorsClaims) {
      const contributorAdaAmount = claim.metadata?.adaAmount || 0;

      // VT token distribution (existing logic)
      const baseVtShare = Math.floor(claim.amount / claim.transaction.assets.length);
      const vtRemainder = claim.amount - baseVtShare * claim.transaction.assets.length;

      // ADA distribution among assets
      const baseAdaShare = Math.floor(contributorAdaAmount / claim.transaction.assets.length);
      const adaRemainder = contributorAdaAmount - baseAdaShare * claim.transaction.assets.length;

      claim.transaction.assets.forEach((asset, index) => {
        const vtShare = baseVtShare + (index < vtRemainder ? 1 : 0);
        acquireMultiplier.push([asset.policy_id, asset.asset_id, vtShare]);
        const adaShare = baseAdaShare + (index < adaRemainder ? 1 : 0);
        adaDistribution.push([asset.policy_id, asset.asset_id, adaShare]);
      });
    }

    for (const claim of acquirerClaims) {
      const multiplier = claim.metadata?.multiplier || Math.floor(claim.amount / claim.transaction.amount / 1_000_000);
      acquireMultiplier.push(['', '', multiplier]);
    }

    return {
      acquireMultiplier,
      adaDistribution,
    };
  }

  /**
   * Calculates the LP ADA multiplier with precision validation
   * @returns Object containing the multiplier and validation info
   */
  calculateLpAdaMultiplier(
    lpVtAmount: number,
    totalAcquiredAda: number
  ): {
    adaPairMultiplier: number;
  } {
    const multiplier = Math.floor(lpVtAmount / (totalAcquiredAda * 1_000_000));

    return { adaPairMultiplier: multiplier };
  }

  private round15(amount: number): number {
    return Math.round(amount * 1e25) / 1e25;
  }

  protected round2(amount: number): number {
    return Math.round(amount * 1e2) / 1e2;
  }
}
