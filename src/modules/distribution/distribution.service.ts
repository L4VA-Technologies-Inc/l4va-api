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

  private calculateVtPrice(adaSent: number, VT_SUPPLY: number, ASSETS_OFFERED_PERCENT: number): number {
    return adaSent / ASSETS_OFFERED_PERCENT / VT_SUPPLY;
  }

  private calculateTotalValueRetained(netAda: number, vtAda: number, lpAda: number, lpVtAda: number): number {
    return this.round6(netAda + vtAda + lpAda + lpVtAda);
  }

  private calculateLpAda(adaSent: number, LP_PERCENT: number): number {
    return adaSent * LP_PERCENT;
  }

  async calculateContributorExample(params: { vaultId: string; valueContributed: number; totalTvl: number }): Promise<{
    vtRetained: number;
    lpVtRetained: number;
    lpAdaRetained: number;
    totalRetainedValue: number;
  }> {
    const { vaultId, valueContributed, totalTvl } = params;

    // Fetch vault from DB
    const vault = await this.vaultsRepository.findOneByOrFail({ id: vaultId });

    const contributorShare = valueContributed / totalTvl;

    const VT_SUPPLY = vault.ft_token_supply;
    const ASSETS_OFFERED_PERCENT = vault.tokens_for_acquires * 0.01;
    const LP_PERCENT = vault.liquidity_pool_contribution * 0.01;

    const vtPrice = this.round6(this.calculateVtPrice(valueContributed, VT_SUPPLY, ASSETS_OFFERED_PERCENT));

    const lpAda = this.round6(this.calculateLpAda(valueContributed, LP_PERCENT));
    const lpVt = this.round6(VT_SUPPLY * ASSETS_OFFERED_PERCENT * LP_PERCENT);

    const vtRetained = this.round6(VT_SUPPLY * (1 - ASSETS_OFFERED_PERCENT) * contributorShare);
    const lpVtRetained = this.round6(lpVt * LP_PERCENT);
    const lpAdaRetained = this.round6(lpAda * LP_PERCENT);

    const vtAdaValue = this.round6(vtRetained * vtPrice);
    const totalRetainedValue = this.round6(this.calculateTotalValueRetained(0, vtAdaValue, lpAdaRetained, 0));

    return {
      vtRetained: Math.round(vtRetained),
      lpVtRetained,
      lpAdaRetained,
      totalRetainedValue,
    };
  }

  async calculateAcquirerExample(params: {
    vaultId: string;
    adaSent: number;
    numAcquirers: number;
    totalAcquiredValueAda: number;
  }): Promise<{
    adaSent: number;
    percentOfTotalAcquireAdaSent: number;
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
    const vault = await this.vaultsRepository.findOneByOrFail({ id: vaultId });

    const VT_SUPPLY = vault.ft_token_supply;
    const ASSETS_OFFERED_PERCENT = vault.tokens_for_acquires * 0.01; // Convert percentage to decimal
    const LP_PERCENT = vault.liquidity_pool_contribution * 0.01; // Convert percentage to decimal

    // const l4vaFee = 5.0;
    // const trxnReserveFee = 5.0;

    const percentOfTotalAcquireAdaSent = this.round6(adaSent / totalAcquiredValueAda);

    const vtPrice = this.round6(this.calculateVtPrice(totalAcquiredValueAda, VT_SUPPLY, ASSETS_OFFERED_PERCENT));

    const lpAda = this.round6(LP_PERCENT * totalAcquiredValueAda);

    // LP (ADA) / VT price
    const lpVt = this.round6(lpAda / vtPrice);

    // ((ADA sent to the vault / total acuiqre ADA) * Assets Offered Percent) * (VT Supply - LP VT)
    const vtReceived = this.round6(percentOfTotalAcquireAdaSent * ASSETS_OFFERED_PERCENT * (VT_SUPPLY - lpVt));

    const vtValueInAda = this.round6(vtReceived * vtPrice);

    const lpAdaInitialShare = this.round6(percentOfTotalAcquireAdaSent * lpAda);

    const lpVtInitialShare = this.round6(percentOfTotalAcquireAdaSent * lpVt);

    const lpVtAdaValue = this.round6(lpVtInitialShare * vtPrice);

    const totalValueInAdaRetained = this.round6(adaSent + vtValueInAda + lpAdaInitialShare + lpVtAdaValue);

    const percentValueRetained = this.round6(totalValueInAdaRetained / adaSent);

    // const valueInAdaRetainedNetOfFees = this.round6(totalValueInAdaRetained - l4vaFee - trxnReserveFee);

    return {
      adaSent: this.round6(adaSent),
      percentOfTotalAcquireAdaSent,
      vtReceived: Math.round(vtReceived),
      vtValueInAda,
      lpAdaInitialShare,
      lpVtInitialShare,
      lpVtAdaValue,
      totalValueInAdaRetained,
      percentValueRetained,
    };
  }
}
