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
 *
 * - Only 1 vault token is minted at contribution/acquire time
 * - Remaining tokens are minted when collecting based on multipliers
 * - Support for acquire_multiplier and ada_pair_multiplier
 */
@Injectable()
export class DistributionService {
  constructor(
    @InjectRepository(Vault)
    private readonly vaultsRepository: Repository<Vault>
  ) {}

  async calculateContributorTokens(params: {
    vaultId: string;
    valueContributed: number;
    totalTvl: number;
    assetPolicyId?: string;
    assetName?: string;
  }): Promise<{
    vtInitialMinted: number; // Always 1 token minted on contribution
    vtToMintOnCollection: number; // Remaining tokens to mint when collecting
    vtRetained: number;
    lpVtRetained: number;
    lpAdaRetained: number;
    totalRetainedValue: number;
    multiplier: number;
  }> {
    const { vaultId, valueContributed, totalTvl, assetPolicyId, assetName } = params;

    // Fetch vault from DB
    const vault = await this.vaultsRepository.findOneByOrFail({ id: vaultId });

    const contributorShare = valueContributed / totalTvl;

    const VT_SUPPLY = vault.ft_token_supply;
    const ASSETS_OFFERED_PERCENT = vault.tokens_for_acquires * 0.01;
    const LP_PERCENT = vault.liquidity_pool_contribution * 0.01;

    const contributionType = assetPolicyId ? 'Asset' : 'ADA'; // TODO: fix this

    // Calculate multiplier based on contribution type
    const multiplier = this.calculateMultiplier(vault, contributionType, assetPolicyId, assetName);

    // New smart contract behavior: Only 1 token minted on contribution
    const vtInitialMinted = 1;

    // Calculate total tokens that should be minted based on contribution and multiplier
    const totalTokensForContribution = Math.floor(valueContributed * multiplier);

    // Remaining tokens to mint when collecting (total - already minted)
    const vtToMintOnCollection = Math.max(0, totalTokensForContribution - vtInitialMinted);

    const vtPrice = this.round6(this.calculateVtPrice(valueContributed, VT_SUPPLY, ASSETS_OFFERED_PERCENT));

    const lpAda = this.round6(this.calculateLpAda(valueContributed, LP_PERCENT));
    const lpVt = this.round6(VT_SUPPLY * ASSETS_OFFERED_PERCENT * LP_PERCENT);

    const vtRetained = this.round6(VT_SUPPLY * (1 - ASSETS_OFFERED_PERCENT) * contributorShare);
    const lpVtRetained = this.round6(lpVt * LP_PERCENT);
    const lpAdaRetained = this.round6(lpAda * LP_PERCENT);

    const vtAdaValue = this.round6(vtRetained * vtPrice);
    const totalRetainedValue = this.round6(this.calculateTotalValueRetained(0, vtAdaValue, lpAdaRetained, 0));

    return {
      vtInitialMinted,
      vtToMintOnCollection,
      vtRetained: Math.round(vtRetained),
      lpVtRetained,
      lpAdaRetained,
      totalRetainedValue,
      multiplier,
    };
  }

  async calculateAcquirerTokens(params: {
    vaultId: string;
    adaSent: number;
    numAcquirers: number;
    totalAcquiredValueAda: number;
  }): Promise<{
    adaSent: number;
    percentOfTotalAcquireAdaSent: number;
    vtInitialMinted: number; // Always 1 token minted on acquire
    vtToMintOnCollection: number; // Remaining tokens to mint when collecting
    vtReceived: number;
    vtValueInAda: number;
    lpAdaInitialShare: number;
    lpVtInitialShare: number;
    lpVtAdaValue: number;
    totalValueInAdaRetained: number;
    percentValueRetained: number;
    multiplier: number;
  }> {
    const { vaultId, adaSent, totalAcquiredValueAda } = params;

    // Fetch vault from DB
    const vault = await this.vaultsRepository.findOneByOrFail({ id: vaultId });

    const VT_SUPPLY = vault.ft_token_supply;
    const ASSETS_OFFERED_PERCENT = vault.tokens_for_acquires * 0.01; // Convert percentage to decimal
    const LP_PERCENT = vault.liquidity_pool_contribution * 0.01; // Convert percentage to decimal

    // Calculate multiplier for ADA acquires (using ada_pair_multiplier)
    const multiplier = vault.ada_pair_multiplier || 1;

    // New smart contract behavior: Only 1 token minted on acquire
    const vtInitialMinted = 1;

    const percentOfTotalAcquireAdaSent = this.round6(adaSent / totalAcquiredValueAda);

    const vtPrice = this.round6(this.calculateVtPrice(totalAcquiredValueAda, VT_SUPPLY, ASSETS_OFFERED_PERCENT));

    const lpAda = this.round6(LP_PERCENT * totalAcquiredValueAda);

    // LP (ADA) / VT price
    const lpVt = this.round6(lpAda / vtPrice);

    // ((ADA sent to the vault / total acquire ADA) * Assets Offered Percent) * (VT Supply - LP VT)
    const vtReceived = this.round6(percentOfTotalAcquireAdaSent * ASSETS_OFFERED_PERCENT * (VT_SUPPLY - lpVt));

    // Calculate total tokens that should be minted based on ADA sent and multiplier
    const totalTokensForAcquire = Math.floor(adaSent * multiplier);

    // Remaining tokens to mint when collecting (total - already minted)
    const vtToMintOnCollection = Math.max(0, totalTokensForAcquire - vtInitialMinted);

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
      vtInitialMinted,
      vtToMintOnCollection,
      vtReceived: Math.round(vtReceived),
      vtValueInAda,
      lpAdaInitialShare,
      lpVtInitialShare,
      lpVtAdaValue,
      totalValueInAdaRetained,
      percentValueRetained,
      multiplier,
    };
  }

  private calculateMultiplier(
    vault: Vault,
    contributionType: 'ADA' | 'Asset',
    assetPolicyId?: string,
    assetName?: string
  ): number {
    if (contributionType === 'ADA') {
      // For ADA contributions, use ada_pair_multiplier if available, otherwise default to 1
      return vault.ada_pair_multiplier || 1;
    }

    if (contributionType === 'Asset' && assetPolicyId && vault.acquire_multiplier) {
      // For asset contributions, find matching multiplier
      for (const item of vault.acquire_multiplier) {
        if (Array.isArray(item) && item.length === 3) {
          const [policyId, assetNameFilter, multiplier] = item;
          // Check if policy ID matches
          if (policyId === assetPolicyId) {
            // If no asset name filter (None), or asset name matches the filter
            if (!assetNameFilter || assetNameFilter === assetName) {
              return multiplier;
            }
          }
        }
      }
    }

    // Default multiplier if no specific match found
    return 1;
  }

  /**
   * Calculate tokens to be reminted when collecting vault tokens
   * Formula: (contributed_amount × multiplier) - 1 (already minted)
   */
  async calculateTokenCollection(params: {
    vaultId: string;
    contributedAmount: number;
    contributionType: 'ADA' | 'Asset';
    assetPolicyId?: string;
    assetName?: string;
  }): Promise<{
    tokensToRemint: number;
    multiplier: number;
    totalTokens: number;
  }> {
    const { vaultId, contributedAmount, contributionType, assetPolicyId, assetName } = params;

    // Fetch vault from DB
    const vault = await this.vaultsRepository.findOneByOrFail({ id: vaultId });

    // Calculate multiplier
    const multiplier = this.calculateMultiplier(vault, contributionType, assetPolicyId, assetName);

    // Calculate total tokens that should exist
    const totalTokens = Math.floor(contributedAmount * multiplier);

    // Tokens to remint = total - 1 (already minted on contribution)
    const tokensToRemint = Math.max(0, totalTokens - 1);

    return {
      tokensToRemint,
      multiplier,
      totalTokens,
    };
  }

  async calculateLpTokens(): Promise<{
    lpAdaAmount: number;
    lpVtAmount: number;
    lpTokensReceived: number;
  }> {
    // Implementation for LP token calculations would go here
    return {
      lpAdaAmount: 0,
      lpVtAmount: 0,
      lpTokensReceived: 0,
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
