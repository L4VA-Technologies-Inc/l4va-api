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

    // Safety check for division by zero
    if (!totalAcquiredValueAda || totalAcquiredValueAda <= 0) {
      this.logger.warn(`Invalid totalAcquiredValueAda: ${totalAcquiredValueAda}. Using default values.`);
      return { vtReceived: 0, multiplier: 0 };
    }

    // Calculate with full precision without rounding
    const percentOfTotalAcquireAdaSent = adaSent / totalAcquiredValueAda;
    const vtReceived = percentOfTotalAcquireAdaSent * ASSETS_OFFERED_PERCENT * (vtSupply - lpVtAmount);

    // Safety check for invalid values
    if (!Number.isFinite(vtReceived)) {
      this.logger.warn(`Invalid vtReceived calculated: ${vtReceived}. Using default values.`);
      return { vtReceived: 0, multiplier: 0 };
    }

    // Calculate multiplier with safe division
    const multiplier = adaSent > 0 ? Math.floor(vtReceived / adaSent / 1_000_000) : 0;
    const adjustedVtAmount = multiplier * adaSent * 1_000_000;

    return {
      vtReceived: adjustedVtAmount,
      multiplier,
    };
  }

  calculateContributorTokens(params: {
    txContributedValue: number;
    userTotalValue: number;
    totalTvl: number;
    lpVtAmount: number;
    lpAdaAmount: number;
    vtPrice: number;
    vtSupply: number;
    ASSETS_OFFERED_PERCENT: number;
  }): {
    vtAmount: number;
    adaAmount: number;
    proportionOfUserTotal: number;
    userTotalVtTokens: number;
  } {
    const { txContributedValue, userTotalValue, totalTvl, lpVtAmount, vtPrice, vtSupply, ASSETS_OFFERED_PERCENT } =
      params;

    // Safety checks
    if (totalTvl <= 0) {
      this.logger.warn(`Invalid totalTvl: ${totalTvl}. Using default values.`);
      return { vtAmount: 0, adaAmount: 0, proportionOfUserTotal: 0, userTotalVtTokens: 0 };
    }

    // Calculate proportion with safety check
    const proportionOfUserTotal = userTotalValue > 0 ? txContributedValue / userTotalValue : 0;

    // Calculate with full precision
    const contributorShare = userTotalValue / totalTvl;
    const userTotalVtTokens = (vtSupply - lpVtAmount) * (1 - ASSETS_OFFERED_PERCENT) * contributorShare;

    // Calculate tokens for this transaction
    const vtAmount = userTotalVtTokens * proportionOfUserTotal;
    const adaAmount = vtAmount * vtPrice;

    // Check for valid numbers
    if (!Number.isFinite(vtAmount) || !Number.isFinite(adaAmount)) {
      this.logger.warn(`Invalid calculation result: vtAmount=${vtAmount}, adaAmount=${adaAmount}`);
      return { vtAmount: 0, adaAmount: 0, proportionOfUserTotal: 0, userTotalVtTokens: 0 };
    }

    return {
      vtAmount: Math.floor(vtAmount),
      adaAmount: Math.floor(adaAmount * 1_000_000), // Convert to lovelace
      proportionOfUserTotal,
      userTotalVtTokens: Math.round(userTotalVtTokens),
    };
  }

  /**
   * Calculate liquidity pool tokens and values with full precision
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

    if (vtSupply <= 0 || assetsOfferedPercent <= 0) {
      this.logger.warn(`Invalid inputs: vtSupply=${vtSupply}, assetsOfferedPercent=${assetsOfferedPercent}`);
      return { lpAdaAmount: 0, lpVtAmount: 0, vtPrice: 0, fdv: 0 };
    }

    const vtPrice = totalAcquiredAda / assetsOfferedPercent / vtSupply;

    if (!Number.isFinite(vtPrice)) {
      this.logger.warn(`Invalid vtPrice calculated: ${vtPrice}`);
      return { lpAdaAmount: 0, lpVtAmount: 0, vtPrice: 0, fdv: 0 };
    }

    const fdv = totalAcquiredAda / assetsOfferedPercent;
    const lpTotalValue = fdv * lpPercent;
    const lpAdaAmount = lpTotalValue / 2;
    const lpVtValue = lpTotalValue / 2;

    const lpVtAmount = vtPrice > 0 ? Math.round(lpVtValue / vtPrice) : 0;

    return {
      lpAdaAmount: Number.isFinite(lpAdaAmount) ? lpAdaAmount : 0,
      lpVtAmount: Number.isFinite(lpVtAmount) ? lpVtAmount : 0,
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

      // VT token distribution
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
    lpAdaAmount: number
  ): {
    adaPairMultiplier: number;
  } {
    const lpLovelaceAmount = lpAdaAmount * 1_000_000;
    // Calculate the multiplier (VT per ADA)
    const multiplier = Math.floor(lpVtAmount / lpLovelaceAmount);

    return {
      adaPairMultiplier: 2, // for now
    };
  }
}
