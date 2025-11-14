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
    adjustedVtLpAmount: number;
    adaPairMultiplier: number;
  } {
    const { totalAcquiredAda, assetsOfferedPercent, lpPercent, vtSupply } = params;

    const fdv = this.round2(totalAcquiredAda / assetsOfferedPercent);

    // Divide equally between ADA and VT
    const lpAdaAmount = Math.round(((lpPercent * fdv) / 2) * 1e6) / 1e6;
    const lpVtValue = this.round15((lpPercent * vtSupply) / 2);

    // LP ADA / LP VT
    const vtPrice = this.round15(lpAdaAmount / lpVtValue);

    const adaPairMultiplier = Math.floor(lpVtValue / (totalAcquiredAda * 1_000_000));
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

  private round15(amount: number): number {
    return Math.round(amount * 1e25) / 1e25;
  }

  protected round2(amount: number): number {
    return Math.round(amount * 1e2) / 1e2;
  }
}
