import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { Claim } from '@/database/claim.entity';
import { Vault } from '@/database/vault.entity';
import { VaultManagingService } from '@/modules/vaults/processing-tx/onchain/vault-managing.service';
import { SmartContractVaultStatus } from '@/types/vault.types';

/**
 * Multi-Batch Distribution Service
 *
 * Handles splitting multiplier arrays across multiple transactions when
 * the full array would exceed Cardano's 16KB transaction size limit.
 *
 * Uses binary search to find the optimal split point.
 */
@Injectable()
export class MultiBatchDistributionService {
  private readonly logger = new Logger(MultiBatchDistributionService.name);

  // Target 85% of max size to leave room for signatures and other tx data
  private readonly TARGET_SIZE_PERCENT = 85;
  private readonly MAX_TX_SIZE_BYTES = 16384;

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Claim)
    private readonly claimRepository: Repository<Claim>,
    private readonly vaultManagingService: VaultManagingService
  ) {}

  /**
   * MANUAL METHOD: Get required multipliers for specific claim IDs
   * Use this to determine what multipliers need to be on-chain for claims to process
   *
   * @param vaultId - The vault ID
   * @param claimIds - Array of claim IDs to check
   * @returns Information about required multipliers and current status
   */
  async getRequiredMultipliersForClaims(
    vaultId: string,
    claimIds: string[]
  ): Promise<{
    vaultId: string;
    currentOnChainMultipliers: number;
    claims: Array<{
      claimId: string;
      claimBatch: number | null;
      status: string;
      canProcess: boolean;
      transactionId: string;
      contributedAssets: Array<{
        policyId: string;
        assetName: string;
        assetId: string;
        quantity: number;
        multiplierOnChain: boolean;
        multiplierValue: number | null;
      }>;
    }>;
    requiredMultipliers: Array<[string, string | null, number]>;
    recommendation: string;
  }> {
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      select: ['id', 'acquire_multiplier', 'manual_distribution_mode'],
    });

    if (!vault) {
      throw new Error(`Vault ${vaultId} not found`);
    }

    const claims = await this.claimRepository.find({
      where: { id: In(claimIds), vault_id: vaultId },
      relations: ['transaction', 'transaction.assets', 'user'],
    });

    if (claims.length === 0) {
      throw new Error(`No claims found for IDs: ${claimIds.join(', ')}`);
    }

    const onChainMultipliers = vault.acquire_multiplier || [];
    const onChainMultiplierMap = new Map<string, number>();
    for (const [policyId, assetName, mult] of onChainMultipliers) {
      const key = assetName ? `${policyId}:${assetName}` : policyId;
      onChainMultiplierMap.set(key, mult);
    }

    const requiredMultipliers = new Map<string, [string, string | null, number]>();
    const claimDetails = [];

    for (const claim of claims) {
      const contributedAssets = claim.transaction?.assets || [];
      const assetDetails = [];

      for (const asset of contributedAssets) {
        const key = asset.asset_id ? `${asset.policy_id}:${asset.asset_id}` : asset.policy_id;
        const policyKey = asset.policy_id;

        let multiplierValue: number | null = null;
        let multiplierOnChain = false;

        // Check if specific asset multiplier exists
        if (asset.asset_id && onChainMultiplierMap.has(key)) {
          multiplierValue = onChainMultiplierMap.get(key);
          multiplierOnChain = true;
        }
        // Check if policy-level multiplier exists
        else if (onChainMultiplierMap.has(policyKey)) {
          multiplierValue = onChainMultiplierMap.get(policyKey);
          multiplierOnChain = true;
        }

        assetDetails.push({
          policyId: asset.policy_id,
          assetName: asset.name,
          assetId: asset.asset_id || '',
          quantity: Number(asset.quantity),
          multiplierOnChain,
          multiplierValue,
        });
      }

      const canProcess = assetDetails.every(a => a.multiplierOnChain);
      claimDetails.push({
        claimId: claim.id,
        status: claim.status,
        canProcess,
        transactionId: claim.transaction?.id,
        contributedAssets: assetDetails,
      });
    }

    const requiredMultipliersArray = Array.from(requiredMultipliers.values());
    const allClaimsCanProcess = claimDetails.every(c => c.canProcess);

    let recommendation = '';
    if (allClaimsCanProcess) {
      recommendation = '✅ All claims can be processed with current on-chain multipliers.';
    } else {
      const missingCount = claimDetails.filter(c => !c.canProcess).length;
      recommendation =
        `⚠️ ${missingCount} claim(s) cannot be processed. ` +
        `${requiredMultipliersArray.length} multiplier(s) need to be added on-chain. ` +
        `Use manuallyUpdateVaultMultipliers() to add them.`;
    }

    return {
      vaultId,
      currentOnChainMultipliers: onChainMultipliers.length,
      claims: claimDetails,
      requiredMultipliers: requiredMultipliersArray,
      recommendation,
    };
  }

  /**
   * MANUAL METHOD: Manually update vault with additional multipliers
   * Use this when automated batch progression is disabled (manual_distribution_mode = true)
   *
   * @param vaultId - The vault ID
   * @param additionalMultipliers - Multipliers to add to the vault (or replace existing if replaceExisting=true)
   * @param additionalAdaDistribution - ADA distribution to add (or replace existing if replaceExisting=true)
   * @param updateDescription - Optional description of why this manual update is needed
   * @param replaceExisting - If true, use ONLY the passed multipliers instead of appending to existing ones
   * @returns Transaction hash and updated vault state
   */
  async manuallyUpdateVaultMultipliers(
    vaultId: string,
    additionalMultipliers: Array<[string, string | null, number]>,
    additionalAdaDistribution: Array<[string, string, number]> = [],
    updateDescription?: string,
    replaceExisting = false
  ): Promise<{
    success: boolean;
    txHash?: string;
    message: string;
    newMultiplierCount: number;
    newOnChainMultipliers: Array<[string, string | null, number]>;
  }> {
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      select: [
        'id',
        'asset_vault_name',
        'privacy',
        'contribution_phase_start',
        'contribution_duration',
        'value_method',
        'acquire_multiplier',
        'ada_distribution',
        'ada_pair_multiplier',
        'manual_distribution_mode',
      ],
    });

    if (!vault) {
      throw new Error(`Vault ${vaultId} not found`);
    }

    if (!vault.manual_distribution_mode) {
      this.logger.warn(
        `Vault ${vaultId} is not in manual mode. Consider enabling manual_distribution_mode flag first.`
      );
    }

    // Either replace existing multipliers or append to them
    let newMultipliers: Array<[string, string | null, number]>;
    let newAdaDistribution: Array<[string, string, number]>;

    if (replaceExisting) {
      // Use ONLY the passed multipliers - don't append to existing
      newMultipliers = additionalMultipliers;
      newAdaDistribution = additionalAdaDistribution;
      this.logger.log(
        `Manual vault update for ${vaultId}: ` +
          `REPLACING with ${additionalMultipliers.length} multipliers (replaceExisting=true). ` +
          `${updateDescription ? `Reason: ${updateDescription}` : ''}`
      );
    } else {
      // Combine existing on-chain multipliers with new ones
      const existingMultipliers = vault.acquire_multiplier || [];
      const existingAdaDistribution = vault.ada_distribution || [];
      newMultipliers = [...existingMultipliers, ...additionalMultipliers];
      newAdaDistribution = [...existingAdaDistribution, ...additionalAdaDistribution];
      this.logger.log(
        `Manual vault update for ${vaultId}: ` +
          `Adding ${additionalMultipliers.length} multipliers. ` +
          `Total will be ${newMultipliers.length}. ` +
          `${updateDescription ? `Reason: ${updateDescription}` : ''}`
      );
    }

    try {
      // Submit vault update transaction
      const response = await this.vaultManagingService.updateVaultMetadataTx({
        vault,
        acquireMultiplier: newMultipliers,
        adaDistribution: newAdaDistribution,
        adaPairMultiplier: vault.ada_pair_multiplier || 0,
        vaultStatus: SmartContractVaultStatus.SUCCESSFUL,
      });

      if (!response.txHash) {
        throw new Error('No transaction hash returned from vault update');
      }

      // Update vault in database with the transaction reference
      await this.vaultRepository.update(vaultId, {
        acquire_multiplier: newMultipliers,
        ada_distribution: newAdaDistribution,
        last_update_tx_hash: response.txHash,
        last_update_tx_index: 0, // Vault token is always first output
      });

      return {
        success: true,
        txHash: response.txHash,
        message: `Successfully added ${additionalMultipliers.length} multipliers to vault. Transaction: ${response.txHash}`,
        newMultiplierCount: newMultipliers.length,
        newOnChainMultipliers: newMultipliers,
      };
    } catch (error) {
      this.logger.error(`Failed to manually update vault ${vaultId}:`, error);
      throw error;
    }
  }
}
