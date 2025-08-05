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
    lpVtAmount: number;
    lpAdaAmount: number;
    vtPrice: number;
  }): Promise<{
    vtInitialMinted: number; // Always 1 token minted on contribution
    vtToMintOnCollection: number; // Remaining tokens to mint when collecting
    vtRetained: number;
    lpVtRetained: number;
    lpAdaRetained: number;
    totalRetainedValue: number;
    multiplier: number;
  }> {
    const { vaultId, valueContributed, totalTvl, lpVtAmount, lpAdaAmount, vtPrice } = params;

    // Fetch vault from DB
    const vault = await this.vaultsRepository.findOneByOrFail({ id: vaultId });

    const contributorShare = valueContributed / totalTvl;

    const VT_SUPPLY = vault.ft_token_supply;
    const ASSETS_OFFERED_PERCENT = vault.tokens_for_acquires * 0.01;
    const LP_PERCENT = vault.liquidity_pool_contribution * 0.01;

    // Calculate multiplier based on contribution type
    const multiplier = this.calculateMultiplier(vault, '', undefined);

    // New smart contract behavior: Only 1 token minted on contribution
    const vtInitialMinted = 1;

    // Calculate total tokens that should be minted based on contribution and multiplier
    const totalTokensForContribution = Math.floor(valueContributed * multiplier);

    // Remaining tokens to mint when collecting (total - already minted)
    const vtToMintOnCollection = Math.max(0, totalTokensForContribution - vtInitialMinted);

    const vtRetained = this.round6(VT_SUPPLY * (1 - ASSETS_OFFERED_PERCENT) * contributorShare);
    const lpVtRetained = this.round6(lpVtAmount * LP_PERCENT);
    const lpAdaRetained = this.round6(lpAdaAmount * LP_PERCENT);

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
    lpVtAmount: number;
    lpAdaAmount: number;
    vtPrice: number;
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
    const { vaultId, adaSent, totalAcquiredValueAda, lpVtAmount, lpAdaAmount, vtPrice } = params;

    // Fetch vault from DB
    const vault = await this.vaultsRepository.findOneByOrFail({ id: vaultId });

    const VT_SUPPLY = vault.ft_token_supply;
    const ASSETS_OFFERED_PERCENT = vault.tokens_for_acquires * 0.01; // Convert percentage to decimal

    // Calculate multiplier for ADA acquires (using ada_pair_multiplier)
    const multiplier = vault.ada_pair_multiplier || 1;

    // New smart contract behavior: Only 1 token minted on acquire
    const vtInitialMinted = 1;

    const percentOfTotalAcquireAdaSent = this.round6(adaSent / totalAcquiredValueAda);

    // ((ADA sent to the vault / total acquire ADA) * Assets Offered Percent) * (VT Supply - LP VT)
    const vtReceived = this.round6(percentOfTotalAcquireAdaSent * ASSETS_OFFERED_PERCENT * (VT_SUPPLY - lpVtAmount));

    // Calculate total tokens that should be minted based on ADA sent and multiplier
    const totalTokensForAcquire = Math.floor(adaSent * multiplier);

    // Remaining tokens to mint when collecting (total - already minted)
    const vtToMintOnCollection = Math.max(0, totalTokensForAcquire - vtInitialMinted);

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

  async calculateTokenCollection(params: {
    vaultId: string;
    contributedAmount: number;
    assetPolicyId?: string;
    assetName?: string;
  }): Promise<number> {
    const { vaultId, contributedAmount, assetPolicyId, assetName } = params;

    // Get vault from repository
    const vault = await this.vaultsRepository.findOneByOrFail({ id: vaultId });

    // Calculate multiplier based on asset type
    const multiplier = this.calculateMultiplier(vault, assetPolicyId, assetName);

    // Formula: (contributed_amount × multiplier) - 1 (already minted)
    const tokensToRemint = contributedAmount * multiplier - 1;

    return Math.max(0, tokensToRemint); // Ensure non-negative
  }

  // Helper method to determine multiplier based on asset type
  private calculateMultiplier(vault: Vault, assetPolicyId?: string, assetName?: string): number {
    // For ADA contributions
    if (!assetPolicyId) {
      return vault.ada_pair_multiplier || 1;
    }

    // Find specific asset multiplier in acquire_multiplier array
    if (vault.acquire_multiplier && vault.acquire_multiplier.length > 0) {
      // Try to find exact match with assetName
      const exactMatch = vault.acquire_multiplier.find(
        ([policy, asset]) => policy === assetPolicyId && asset === assetName
      );

      if (exactMatch) {
        return exactMatch[2]; // Return the multiplier
      }

      // Try to find policy-wide match (empty assetName)
      const policyMatch = vault.acquire_multiplier.find(([policy, asset]) => policy === assetPolicyId && asset === '');

      if (policyMatch) {
        return policyMatch[2];
      }
    }

    // Default multiplier if no specific match found
    return 1;
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

  /**
   * Mint vault tokens with multiplier
   * Based on the new smart contract behavior where only 1 token is minted initially
   */
  async calculateTokensToMint(params: {
    contributionAmount: number; // Either ADA amount or asset value in ADA
    vaultId: string;
    assetPolicyId?: string;
    assetName?: string;
    isInitialMint?: boolean;
  }): Promise<{
    tokensToMint: number;
    multiplier: number;
  }> {
    const { contributionAmount, vaultId, assetPolicyId, assetName, isInitialMint = false } = params;

    // Fetch vault from DB
    const vault = await this.vaultsRepository.findOneByOrFail({ id: vaultId });

    // Calculate multiplier based on contribution type and asset
    const multiplier = this.calculateMultiplier(vault, assetPolicyId, assetName);

    // Calculate total tokens that should be minted based on contribution and multiplier
    const totalTokens = Math.floor(contributionAmount * multiplier);

    let tokensToMint: number;

    if (isInitialMint) {
      // For initial mint during contribution/acquire, only mint 1 token
      tokensToMint = 1;
    } else {
      // For collection, mint the remaining tokens
      tokensToMint = Math.max(0, totalTokens - 1);
    }

    return {
      tokensToMint,
      multiplier,
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
