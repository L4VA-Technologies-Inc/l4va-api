import { Injectable } from '@nestjs/common';

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
  constructor() {}

  async calculateContributorTokens(params: {
    valueContributed: number;
    totalTvl: number;
    lpVtAmount: number;
    lpAdaAmount: number;
    vtPrice: number;
    VT_SUPPLY: number;
    ASSETS_OFFERED_PERCENT: number;
    LP_PERCENT: number;
  }): Promise<{
    vtRetained: number;
    lpVtRetained: number;
    lpAdaRetained: number;
    totalRetainedValue: number;
  }> {
    const {
      VT_SUPPLY,
      ASSETS_OFFERED_PERCENT,
      LP_PERCENT,
      valueContributed,
      totalTvl,
      lpVtAmount,
      lpAdaAmount,
      vtPrice,
    } = params;

    const contributorShare = valueContributed / totalTvl;
    const vtRetained = this.round6(VT_SUPPLY * (1 - ASSETS_OFFERED_PERCENT) * contributorShare);
    const lpVtRetained = this.round6(lpVtAmount * LP_PERCENT);
    const lpAdaRetained = this.round6(lpAdaAmount * LP_PERCENT);
    const vtAdaValue = this.round6(vtRetained * vtPrice);
    const totalRetainedValue = this.round6(this.calculateTotalValueRetained(0, vtAdaValue, lpAdaRetained, 0));

    return {
      vtRetained: Math.round(vtRetained),
      lpVtRetained,
      lpAdaRetained,
      totalRetainedValue,
    };
  }

  async calculateAcquirerTokens(params: {
    vaultId: string;
    adaSent: number;
    numAcquirers: number;
    totalAcquiredValueAda: number;
    lpVtAmount: number;
    lpAdaAmount: number;
    VT_SUPPLY: number;
    ASSETS_OFFERED_PERCENT: number;
    vtPrice: number;
  }): Promise<{
    adaSent: number;
    percentOfTotalAcquireAdaSent: number;
    vtReceived: number;
    vtValueInAda: number;

    totalValueInAdaRetained: number;
    percentValueRetained: number;
  }> {
    const { adaSent, VT_SUPPLY, ASSETS_OFFERED_PERCENT, totalAcquiredValueAda, lpVtAmount, lpAdaAmount, vtPrice } =
      params;

    const percentOfTotalAcquireAdaSent = this.round6(adaSent / totalAcquiredValueAda);

    // ((ADA sent to the vault / total acquire ADA) * Assets Offered Percent) * (VT Supply - LP VT)
    const vtReceived = this.round6(percentOfTotalAcquireAdaSent * ASSETS_OFFERED_PERCENT * (VT_SUPPLY - lpVtAmount));

    const vtValueInAda = this.round6(vtReceived * vtPrice);

    const lpAdaInitialShare = this.round6(percentOfTotalAcquireAdaSent * lpAdaAmount);
    const lpVtInitialShare = this.round6(percentOfTotalAcquireAdaSent * lpVtAmount);
    const lpVtAdaValue = this.round6(lpVtInitialShare * vtPrice);
    const totalValueInAdaRetained = this.round6(adaSent + vtValueInAda + lpAdaInitialShare + lpVtAdaValue);
    const percentValueRetained = this.round6(totalValueInAdaRetained / adaSent);

    // const valueInAdaRetainedNetOfFees = this.round6(totalValueInAdaRetained - l4vaFee - trxnReserveFee);

    return {
      adaSent: this.round6(adaSent),
      percentOfTotalAcquireAdaSent,
      vtReceived: Math.round(vtReceived),
      vtValueInAda,
      totalValueInAdaRetained,
      percentValueRetained,
    };
  }

  /**
   * Calculate liquidity pool tokens and values
   * Extracted as a separate method to ensure consistent calculations across
   * contributor and acquirer flows
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
