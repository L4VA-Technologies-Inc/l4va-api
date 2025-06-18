import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LiquidityPoolService } from './lp.service';

import { Vault } from '@/database/vault.entity';

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
  private readonly VT_SUPPLY = 1_000_000;
  private readonly ASSETS_OFFERED_PERCENT = 0.99;
  private readonly RESERVE_RATIO = 0.9;
  private readonly INITIAL_LP_MARKETCAP_PERCENT = 0.08;

  constructor(
    @InjectRepository(Vault)
    private readonly vaultsRepository: Repository<Vault>,
    private readonly liquidityPoolService: LiquidityPoolService
  ) {}

  private round6(amount: number): number {
    return Math.floor(amount * 1e6) / 1e6;
  }

  private calculateAcquireAdaValuation(adaSent: number): number {
    return this.round6(adaSent / this.ASSETS_OFFERED_PERCENT);
  }

  private checkLockStatus(adaValuation: number, assetTVL: number): boolean {
    return adaValuation / assetTVL > this.RESERVE_RATIO;
  }

  private calculateVtPrice(adaSent: number): number {
    return this.round6(this.calculateAcquireAdaValuation(adaSent) / this.VT_SUPPLY);
  }

  private calculateTotalValueRetained(netAda: number, vtAda: number, lpAda: number, lpVtAda: number): number {
    return this.round6(netAda + vtAda + lpAda + lpVtAda);
  }

  calculateNetAdaAfterLp(adaSent: number): number {
    return this.round6(adaSent - this.liquidityPoolService.calculateLpAda(adaSent));
  }

  calculateLpMarketcapRatio(lpAda: number, adaValuation: number): number {
    return this.round6((lpAda * 2) / adaValuation);
  }

  calculateVtAvailableToAcquirers(lpVt: number): number {
    return this.VT_SUPPLY - lpVt;
  }

  calculateVtForAcquirer(vtAvailable: number, adaPortionPercent: number): number {
    return this.round6(vtAvailable * adaPortionPercent);
  }

  calculateContributorAdaShare(assetValue: number, totalAssetTVL: number, netAdaProceeds: number): number {
    return this.round6((assetValue / totalAssetTVL) * netAdaProceeds);
  }

  calculateContributorVtShare(assetValue: number, totalAssetTVL: number, vtAvailable: number): number {
    return this.round6((assetValue / totalAssetTVL) * vtAvailable);
  }

  calculateLockMetrics({ adaSent, assetTVL }: { adaSent: number; assetTVL: number }): {
    adaValuation: number;
    lockSuccess: boolean;
    vtPrice: number;
  } {
    const adaValuation = this.calculateAcquireAdaValuation(adaSent);
    const lockSuccess = this.checkLockStatus(adaValuation, assetTVL);
    const vtPrice = this.calculateVtPrice(adaSent);
    return { adaValuation, lockSuccess, vtPrice };
  }

  calculateContributorExample(params: {
    adaSent: number;
    contributorPercentVt: number;
    contributorLpPercent: number;
  }): {
    impliedAdaValuation: number;
    vtRetained: number;
    lpVtRetained: number;
    lpAdaRetained: number;
    totalRetainedValue: number;
  } {
    const { adaSent, contributorPercentVt, contributorLpPercent } = params;

    const impliedAdaValuation = this.round6(this.calculateAcquireAdaValuation(adaSent));
    const vtPrice = this.round6(this.calculateVtPrice(adaSent));

    const lpAda = this.round6(this.liquidityPoolService.calculateLpAda(adaSent));
    const lpVt = this.round6(this.liquidityPoolService.calculateLpVt(lpAda, vtPrice));

    const vtRetained = this.round6(this.VT_SUPPLY * (1 - this.ASSETS_OFFERED_PERCENT) * contributorPercentVt);
    const lpVtRetained = this.round6(lpVt * contributorLpPercent);
    const lpAdaRetained = this.round6(lpAda * contributorLpPercent);

    const vtAdaValue = this.round6(vtRetained * vtPrice);
    const totalRetainedValue = this.round6(this.calculateTotalValueRetained(0, vtAdaValue, lpAdaRetained, 0));

    return {
      impliedAdaValuation,
      vtRetained,
      lpVtRetained,
      lpAdaRetained,
      totalRetainedValue,
    };
  }

  calculateAcquirerExample(params: { adaSent: number; numAcquirers: number }): {
    adaSent: number;
    percentAssetsOffered: number;
    totalAcquireAdaSent: number;
    percentOfTotalAcquireAdaSent: number;
    percentOfTotalVtNetOfLp: number;
    vtReceived: number;
    vtValueInAda: number;
    lpAdaInitialShare: number;
    lpVtInitialShare: number;
    lpVtAdaValue: number;
    totalValueInAdaRetained: number;
    percentValueRetained: number;
    l4vaFee: number;
    trxnReserveFee: number;
    valueInAdaRetainedNetOfFees: number;
  } {
    const { adaSent } = params;

    const percentAssetsOffered = this.ASSETS_OFFERED_PERCENT;
    const totalAcquireAdaSent = 118000;
    const vtSupply = this.VT_SUPPLY;
    const l4vaFee = 5.0;
    const trxnReserveFee = 5.0;
    const lpOfAdaSent = 0.04;

    const percentOfTotalAcquireAdaSent = this.round6(adaSent / totalAcquireAdaSent);

    const vtPrice = this.round6(this.liquidityPoolService.calculateVtPrice(totalAcquireAdaSent));

    const lpAda = this.round6(lpOfAdaSent * totalAcquireAdaSent);
    const lpVt = this.round6(this.liquidityPoolService.calculateLpVt(lpAda, vtPrice));

    const vtAvailableToAcquirers = this.round6(vtSupply * percentAssetsOffered - lpVt);

    const percentOfTotalVtNetOfLp = percentOfTotalAcquireAdaSent;

    const vtReceived = this.round6(percentOfTotalVtNetOfLp * vtAvailableToAcquirers);

    const vtValueInAda = this.round6(vtReceived * vtPrice);

    const lpAdaInitialShare = this.round6(percentOfTotalVtNetOfLp * lpAda);

    const lpVtInitialShare = this.round6(percentOfTotalVtNetOfLp * lpVt);

    const lpVtAdaValue = this.round6(lpVtInitialShare * vtPrice);

    const totalValueInAdaRetained = this.round6(adaSent + vtValueInAda + lpAdaInitialShare + lpVtAdaValue);

    const percentValueRetained = this.round6(totalValueInAdaRetained / adaSent);

    const valueInAdaRetainedNetOfFees = this.round6(totalValueInAdaRetained - l4vaFee - trxnReserveFee);

    return {
      adaSent: this.round6(adaSent),
      percentAssetsOffered: this.round6(percentAssetsOffered),
      totalAcquireAdaSent: this.round6(totalAcquireAdaSent),
      percentOfTotalAcquireAdaSent,
      percentOfTotalVtNetOfLp,
      vtReceived,
      vtValueInAda,
      lpAdaInitialShare,
      lpVtInitialShare,
      lpVtAdaValue,
      totalValueInAdaRetained,
      percentValueRetained,
      l4vaFee: this.round6(l4vaFee),
      trxnReserveFee: this.round6(trxnReserveFee),
      valueInAdaRetainedNetOfFees,
    };
  }
}
