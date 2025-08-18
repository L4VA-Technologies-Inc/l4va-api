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
    VT_SUPPLY: number;
    ASSETS_OFFERED_PERCENT: number;
    LP_PERCENT: number;
  }): number {
    const { VT_SUPPLY, ASSETS_OFFERED_PERCENT, valueContributed, totalTvl } = params;

    const contributorShare = valueContributed / totalTvl;
    const vtRetained = this.round6(VT_SUPPLY * (1 - ASSETS_OFFERED_PERCENT) * contributorShare);
    // const lpVtRetained = this.round6(lpVtAmount * LP_PERCENT);
    // const lpAdaRetained = this.round6(lpAdaAmount * LP_PERCENT);
    // const vtAdaValue = this.round6(vtRetained * vtPrice);
    // const totalRetainedValue = this.round6(this.calculateTotalValueRetained(0, vtAdaValue, lpAdaRetained, 0));

    return Math.round(vtRetained);
  }

  calculateAcquirerTokens(params: {
    vaultId: string;
    adaSent: number;
    numAcquirers: number;
    totalAcquiredValueAda: number;
    lpVtAmount: number;
    lpAdaAmount: number;
    VT_SUPPLY: number;
    ASSETS_OFFERED_PERCENT: number;
    vtPrice: number;
  }): number {
    const { adaSent, VT_SUPPLY, ASSETS_OFFERED_PERCENT, totalAcquiredValueAda, lpVtAmount } = params;

    // ((ADA sent to the vault / total acquire ADA) * Assets Offered Percent) * (VT Supply - LP VT)
    const percentOfTotalAcquireAdaSent = this.round6(adaSent / totalAcquiredValueAda);
    const vtReceived = this.round6(percentOfTotalAcquireAdaSent * ASSETS_OFFERED_PERCENT * (VT_SUPPLY - lpVtAmount));

    // const vtValueInAda = this.round6(vtReceived * vtPrice);
    // const lpAdaInitialShare = this.round6(percentOfTotalAcquireAdaSent * lpAdaAmount);
    // const lpVtInitialShare = this.round6(percentOfTotalAcquireAdaSent * lpVtAmount);
    // const lpVtAdaValue = this.round6(lpVtInitialShare * vtPrice);
    // const totalValueInAdaRetained = this.round6(adaSent + vtValueInAda + lpAdaInitialShare + lpVtAdaValue);
    // const valueInAdaRetainedNetOfFees = this.round6(totalValueInAdaRetained - l4vaFee - trxnReserveFee);
    return Math.round(vtReceived);
  }

  /**
   * Calculate liquidity pool tokens and values
   */
  async calculateLpTokens(params: {
    vaultId: string;
    totalValue: number;
    vtSupply: number;
    assetsOfferedPercent: number;
    lpPercent: number;
  }): Promise<{
    lpAdaAmount: number;
    lpVtAmount: number;
    lpTokensReceived: number;
    vtPrice: number;
  }> {
    const { totalValue, vtSupply, assetsOfferedPercent, lpPercent } = params;

    // Calculate VT token price
    const vtPrice = this.round6(this.calculateVtPrice(totalValue, vtSupply, assetsOfferedPercent));

    // Calculate ADA allocated to LP
    const lpAdaAmount = this.round6(this.calculateLpAda(totalValue, lpPercent));

    // Calculate VT tokens allocated to LP
    const lpVtAmount = this.round6(vtSupply * assetsOfferedPercent * lpPercent);

    // Calculate LP tokens received (simplified approximation)
    // In reality, this would depend on the specific DEX formula
    const lpTokensReceived = this.round6(Math.sqrt(lpAdaAmount * lpVtAmount));

    return {
      lpAdaAmount,
      lpVtAmount,
      lpTokensReceived,
      vtPrice,
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
      multipliers.push(['', '', Math.floor(claim.amount / claim.transaction.amount / 1_000_000)]);
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
    // Calculate the multiplier (VT per ADA)
    const multiplier = Math.floor(lpVtAmount / lpAdaAmount);

    // Validate precision loss
    const reconstructedVT = multiplier * lpAdaAmount;
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

  private round6(amount: number): number {
    return Math.round(amount * 1e6) / 1e6;
  }

  private calculateVtPrice(adaSent: number, VT_SUPPLY: number, ASSETS_OFFERED_PERCENT: number): number {
    return adaSent / ASSETS_OFFERED_PERCENT / VT_SUPPLY;
  }

  private calculateTotalValueRetained(netAda: number, vtAda: number, lpAda: number, lpVtAda: number): number {
    return this.round6(netAda + vtAda + lpAda + lpVtAda);
  }

  private calculateLpAda(adaSent: number, LP_PERCENT: number): number {
    return adaSent * LP_PERCENT;
  }
}
