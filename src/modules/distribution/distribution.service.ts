import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

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
  constructor(
    @InjectRepository(Vault)
    private readonly vaultsRepository: Repository<Vault>
  ) {}

  private round6(amount: number): number {
    return Math.round(amount * 1e6) / 1e6;
  }

  private calculateAcquireAdaValuation(adaSent: number, ASSETS_OFFERED_PERCENT: number): number {
    return this.round6(adaSent / ASSETS_OFFERED_PERCENT);
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

  private calculateLpVt(lpAda: number, vtPrice: number, LP_PERCENT: number): number {
    return (lpAda / vtPrice) * LP_PERCENT;
  }

  async calculateContributorExample(params: {
    vaultId: number;
    adaSent: number;
    contributorPercentVt: number;
    contributorLpPercent: number;
  }): Promise<{
    impliedAdaValuation: number;
    vtRetained: number;
    lpVtRetained: number;
    lpAdaRetained: number;
    totalRetainedValue: number;
  }> {
    const { adaSent, contributorPercentVt, contributorLpPercent, vaultId } = params;

    // Fetch vault from DB
    const vault = await this.vaultsRepository.findOneByOrFail({ id: vaultId.toString() });

    const VT_SUPPLY = vault.ft_token_supply;
    const ASSETS_OFFERED_PERCENT = vault.tokens_for_acquires;
    const LP_PERCENT = vault.liquidity_pool_contribution;

    const impliedAdaValuation = this.round6(this.calculateAcquireAdaValuation(adaSent, ASSETS_OFFERED_PERCENT));
    const vtPrice = this.round6(this.calculateVtPrice(adaSent, VT_SUPPLY, ASSETS_OFFERED_PERCENT));

    const lpAda = this.round6(this.calculateLpAda(adaSent, LP_PERCENT));
    const lpVt = this.round6(this.calculateLpVt(lpAda, vtPrice, LP_PERCENT));

    const vtRetained = this.round6(VT_SUPPLY * (1 - ASSETS_OFFERED_PERCENT) * contributorPercentVt);
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

  async calculateAcquirerExample(params: {
    vaultId: number;
    adaSent: number;
    numAcquirers: number;
    totalAcquiredValueAda: number;
  }): Promise<{
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
  }> {
    const { vaultId, adaSent, totalAcquiredValueAda } = params;

    // Fetch vault from DB
    const vault = await this.vaultsRepository.findOneByOrFail({ id: vaultId.toString() });

    const VT_SUPPLY = vault.ft_token_supply;
    const ASSETS_OFFERED_PERCENT = vault.tokens_for_acquires;
    const LP_PERCENT = vault.liquidity_pool_contribution;
    // const l4vaFee = 5.0;
    // const trxnReserveFee = 5.0;

    const percentOfTotalAcquireAdaSent = this.round6(adaSent / totalAcquiredValueAda);

    const vtPrice = this.round6(this.calculateVtPrice(totalAcquiredValueAda, VT_SUPPLY, ASSETS_OFFERED_PERCENT));

    const lpAda = this.round6(LP_PERCENT * totalAcquiredValueAda);
    const lpVt = this.round6(this.calculateLpVt(lpAda, vtPrice, LP_PERCENT));

    const vtAvailableToAcquirers = this.round6(VT_SUPPLY * ASSETS_OFFERED_PERCENT - lpVt);

    const percentOfTotalVtNetOfLp = percentOfTotalAcquireAdaSent;

    const vtReceived = this.round6(percentOfTotalVtNetOfLp * vtAvailableToAcquirers);

    const vtValueInAda = this.round6(vtReceived * vtPrice);

    const lpAdaInitialShare = this.round6(percentOfTotalVtNetOfLp * lpAda);

    const lpVtInitialShare = this.round6(percentOfTotalVtNetOfLp * lpVt);

    const lpVtAdaValue = this.round6(lpVtInitialShare * vtPrice);

    const totalValueInAdaRetained = this.round6(adaSent + vtValueInAda + lpAdaInitialShare + lpVtAdaValue);

    const percentValueRetained = this.round6(totalValueInAdaRetained / adaSent);

    // const valueInAdaRetainedNetOfFees = this.round6(totalValueInAdaRetained - l4vaFee - trxnReserveFee);

    return {
      adaSent: this.round6(adaSent),
      percentAssetsOffered: this.round6(ASSETS_OFFERED_PERCENT),
      totalAcquireAdaSent: this.round6(totalAcquiredValueAda),
      percentOfTotalAcquireAdaSent,
      percentOfTotalVtNetOfLp,
      vtReceived,
      vtValueInAda,
      lpAdaInitialShare,
      lpVtInitialShare,
      lpVtAdaValue,
      totalValueInAdaRetained,
      percentValueRetained,
      // l4vaFee: this.round6(l4vaFee),
      // trxnReserveFee: this.round6(trxnReserveFee),
      // valueInAdaRetainedNetOfFees,
    };
  }
}
