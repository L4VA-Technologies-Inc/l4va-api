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

  calculateContributorTokens(params: {
    valueContributed: number;
    totalTvl: number;
    lpVtAmount: number;
    lpAdaAmount: number;
    vtPrice: number;
    vtSupply: number;
    ASSETS_OFFERED_PERCENT: number;
    LP_PERCENT: number;
  }): number {
    const { vtSupply, ASSETS_OFFERED_PERCENT, valueContributed, totalTvl, lpVtAmount } = params;

    const contributorShare = valueContributed / totalTvl;
    const vtRetained = this.round15((vtSupply - lpVtAmount) * (1 - ASSETS_OFFERED_PERCENT) * contributorShare);

    // const lpVtRetained = this.round15(lpVtAmount * LP_PERCENT);
    // const lpAdaRetained = this.round15(lpAdaAmount * LP_PERCENT);
    // const vtAdaValue = this.round15(vtRetained * vtPrice);
    // const totalRetainedValue = this.round15(this.calculateTotalValueRetained(0, vtAdaValue, lpAdaRetained, 0));

    return Math.round(vtRetained);
  }

  calculateAcquirerTokens(params: {
    adaSent: number;
    totalAcquiredValueAda: number;
    lpVtAmount: number;
    lpAdaAmount: number;
    vtSupply: number;
    ASSETS_OFFERED_PERCENT: number;
    vtPrice: number;
  }): number {
    const { adaSent, vtSupply, ASSETS_OFFERED_PERCENT, totalAcquiredValueAda, lpVtAmount } = params;

    // ((ADA sent to the vault / total acquire ADA) * Assets Offered Percent) * (VT Supply - LP VT)
    const percentOfTotalAcquireAdaSent = this.round15(adaSent / totalAcquiredValueAda);
    const vtReceived = this.round15(percentOfTotalAcquireAdaSent * ASSETS_OFFERED_PERCENT * (vtSupply - lpVtAmount));

    // const vtValueInAda = this.round15(vtReceived * vtPrice);
    // const lpAdaInitialShare = this.round15(percentOfTotalAcquireAdaSent * lpAdaAmount);
    // const lpVtInitialShare = this.round15(percentOfTotalAcquireAdaSent * lpVtAmount);
    // const lpVtAdaValue = this.round15(lpVtInitialShare * vtPrice);
    // const totalValueInAdaRetained = this.round15(adaSent + vtValueInAda + lpAdaInitialShare + lpVtAdaValue);
    // const valueInAdaRetainedNetOfFees = this.round15(totalValueInAdaRetained - l4vaFee - trxnReserveFee);
    return Math.round(vtReceived);
  }

  /**
   * Calculate liquidity pool tokens and values
   */
  async calculateLpTokens(params: {
    totalAcquiredAda: number;
    vtSupply: number;
    assetsOfferedPercent: number;
    lpPercent: number;
  }): Promise<{
    lpAdaAmount: number;
    lpVtAmount: number;
    vtPrice: number;
    fdv: number;
  }> {
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

  calculateAcquireMultipliers(params: {
    contributorsClaims: Claim[];
    acquirerClaims: Claim[];
  }): [string, string, number][] {
    const { contributorsClaims, acquirerClaims } = params;
    const multipliers = [];

    for (const claim of contributorsClaims) {
      // Creates eaqual share between all NFTs in same tx, used reminder to always have sum of multipliers eqaul to claim.amount
      const baseShare = Math.floor(claim.amount / claim.transaction.assets.length);
      const remainder = claim.amount - baseShare * claim.transaction.assets.length;
      claim.transaction.assets.forEach((asset, index) => {
        const share = baseShare + (index < remainder ? 1 : 0);
        multipliers.push([asset.policy_id, asset.asset_id, share]);
      });
    }

    for (const claim of acquirerClaims) {
      const multiplier = claim.metadata?.multiplier || Math.floor(claim.amount / claim.transaction.amount / 1_000_000);
      multipliers.push(['', '', multiplier]);
    }

    return multipliers;
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
    precisionLoss: number;
  } {
    const lpLovelaceAmount = lpAdaAmount * 1_000_000;
    // Calculate the multiplier (VT per ADA)
    const multiplier = Math.floor(lpVtAmount / lpLovelaceAmount);

    // Validate precision loss
    const reconstructedVT = multiplier * lpLovelaceAmount;
    const difference = Math.abs(reconstructedVT - lpVtAmount);
    const precisionLoss = (difference / lpVtAmount) * 100;

    // Check if precision loss is significant
    const hasHighPrecisionLoss = precisionLoss > 1;

    if (hasHighPrecisionLoss) {
      this.logger.warn(`High precision loss in LP multiplier: ${precisionLoss.toFixed(2)}% error`);
    }

    return {
      adaPairMultiplier: multiplier,
      precisionLoss,
    };
  }

  private round15(amount: number): number {
    return Math.round(amount * 1e15) / 1e15;
  }

  protected round2(amount: number): number {
    return Math.round(amount * 1e2) / 1e2;
  }

  private calculateTotalValueRetained(netAda: number, vtAda: number, lpAda: number, lpVtAda: number): number {
    return this.round15(netAda + vtAda + lpAda + lpVtAda);
  }
}
