import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { Proposal } from '@/database/proposal.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { VaultManagingService } from '@/modules/vaults/processing-tx/onchain/vault-managing.service';
import { ClaimStatus, ClaimType } from '@/types/claim.types';
import { ProposalStatus, ProposalType } from '@/types/proposal.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';
import { SmartContractVaultStatus, VaultStatus } from '@/types/vault.types';

@Injectable()
export class ExpansionService {
  private readonly logger = new Logger(ExpansionService.name);

  constructor(
    @InjectRepository(Proposal)
    private readonly proposalRepository: Repository<Proposal>,
    @InjectRepository(Claim)
    private readonly claimRepository: Repository<Claim>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Transaction)
    private readonly transactionsRepository: Repository<Transaction>,
    private readonly eventEmitter: EventEmitter2,
    private readonly vaultManagingService: VaultManagingService
  ) {}

  /**
   * Execute expansion proposal
   * Changes vault status to EXPANSION and allows new contributions based on the proposal parameters
   */
  async executeExpansion(proposal: Proposal): Promise<boolean> {
    if (!proposal.metadata?.expansion) {
      this.logger.warn(`Expansion proposal ${proposal.id} has no expansion configuration`);
      return false;
    }

    try {
      const expansionConfig = proposal.metadata.expansion;

      // Fetch full vault data for on-chain update
      const vault = await this.vaultRepository.findOne({
        where: { id: proposal.vaultId },
        select: [
          'id',
          'asset_vault_name',
          'privacy',
          'contribution_phase_start',
          'contribution_duration',
          'value_method',
        ],
      });

      if (!vault) {
        throw new Error(`Vault ${proposal.vaultId} not found`);
      }

      const onChainResult = await this.vaultManagingService.updateVaultMetadataTx({
        vault,
        vaultStatus: SmartContractVaultStatus.OPEN,
        asset_window: expansionConfig.noLimit
          ? {
              start: Date.now(),
              end: Date.now() + 365 * 24 * 60 * 60 * 1000, // Set to 1 year for no limit (effectively infinite)
            }
          : {
              start: Date.now(),
              end: Date.now() + expansionConfig.duration + 5 * 60 * 1000, // Add 5 minutes buffer to ensure on-chain state is updated before accepting contributions
            },
      });

      // Update vault status to EXPANSION in database
      await this.vaultRepository.update(
        { id: proposal.vaultId },
        {
          vault_status: VaultStatus.expansion,
          vault_sc_status: SmartContractVaultStatus.OPEN,
          expansion_phase_start: new Date(),
          expansion_duration: expansionConfig.noLimit ? 365 * 24 * 60 * 60 * 1000 : expansionConfig.duration,
          last_update_tx_hash: onChainResult.txHash,
        }
      );

      // Emit event for tracking
      this.eventEmitter.emit('proposal.expansion.executed', {
        proposalId: proposal.id,
        vaultId: proposal.vaultId,
        expansionConfig,
        onChainTxHash: onChainResult.txHash,
      });

      this.logger.log(`Successfully executed expansion proposal ${proposal.id}`);
      return true;
    } catch (error) {
      this.logger.error(`Error executing expansion proposal ${proposal.id}: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Close vault expansion and return vault to LOCKED status
   * Called when expansion duration expires or asset max is reached
   */
  async closeExpansion(
    vaultId: string,
    proposalId: string,
    reason: 'duration_expired' | 'asset_max_reached'
  ): Promise<void> {
    this.logger.log(`Closing expansion for vault ${vaultId}, reason: ${reason}`);

    try {
      // Fetch vault data for on-chain update
      const vault = await this.vaultRepository.findOne({
        where: { id: vaultId },
        select: [
          'id',
          'asset_vault_name',
          'privacy',
          'contribution_phase_start',
          'contribution_duration',
          'value_method',
        ],
      });

      if (!vault) {
        throw new Error(`Vault ${vaultId} not found`);
      }

      const onChainResult = await this.vaultManagingService.updateVaultMetadataTx({
        vault,
        vaultStatus: SmartContractVaultStatus.SUCCESSFUL,
      });

      this.logger.log(`On-chain vault closure successful. TX: ${onChainResult.txHash}`);

      // Update vault status back to LOCKED in database and clear expansion timing
      await this.vaultRepository.update(
        { id: vaultId },
        {
          vault_status: VaultStatus.locked,
          vault_sc_status: SmartContractVaultStatus.SUCCESSFUL,
          expansion_phase_start: null,
          expansion_duration: null,
          last_update_tx_hash: onChainResult.txHash,
        }
      );

      this.logger.log(`Vault ${vaultId} status changed back to LOCKED`);

      // Emit event for tracking
      this.eventEmitter.emit('vault.expansion.closed', {
        vaultId,
        proposalId,
        reason,
        onChainTxHash: onChainResult.txHash,
      });
    } catch (error) {
      this.logger.error(`Error closing expansion for vault ${vaultId}: ${error.message}`, error.stack);
    }
  }

  /**
   * Execute the transition from Expansion to Locked phase
   * Calculates and creates expansion claims for new contributors
   * Closes the expansion and returns vault to governance (locked) status
   */
  async executeExpansionToLockedTransition(vault: Vault): Promise<void> {
    this.logger.log(`Processing expansion->locked transition for vault ${vault.id}`);

    const expansionProposal = await this.proposalRepository.findOne({
      where: {
        vaultId: vault.id,
        proposalType: ProposalType.EXPANSION,
        status: ProposalStatus.EXECUTED,
      },
      order: { executionDate: 'DESC' },
    });

    if (!expansionProposal) {
      this.logger.error(`No executed expansion proposal found for vault ${vault.id}`);
      return;
    }

    try {
      const expansionContributions = await this.transactionsRepository.find({
        where: {
          vault_id: vault.id,
          type: TransactionType.contribute,
          status: TransactionStatus.confirmed,
          created_at: MoreThanOrEqual(vault.expansion_phase_start), // Only consider contributions from expansion phase start
        },
        relations: ['user', 'assets'],
      });

      this.logger.log(`Found ${expansionContributions.length} contribution(s) during expansion for vault ${vault.id}`);

      // Calculate and create VT claims for expansion contributors
      if (expansionContributions.length > 0) {
        const expansionConfig = expansionProposal.metadata.expansion;
        const createdClaims: Claim[] = [];
        const contributedAssets: Asset[] = [];

        for (const transaction of expansionContributions) {
          try {
            // Calculate asset value in ADA
            const assetValueAda = await this.calculateTotalAssetsValue(transaction.assets);

            // Calculate VT amount based on pricing method
            let vtAmount: string;

            if (expansionConfig.priceType === 'limit') {
              // Limit price: fixed ADA per VT
              if (!expansionConfig.limitPrice || expansionConfig.limitPrice === 0) {
                this.logger.error(
                  `Invalid limit price for expansion proposal ${expansionProposal.id}: ${expansionConfig.limitPrice}`
                );
                continue;
              }

              // VT amount = Asset Value (ADA) / Limit Price (ADA per VT)
              const vtAmountRaw = assetValueAda / expansionConfig.limitPrice;
              vtAmount = Math.floor(vtAmountRaw * 1_000_000).toString(); // Convert to lovelace equivalent (6 decimals)
            } else {
              // Market price: use current VT price from vault
              const currentVtPrice = vault.vt_price;

              if (!currentVtPrice || currentVtPrice === 0) {
                this.logger.error(`Cannot calculate VT amount: VT price is ${currentVtPrice} for vault ${vault.id}`);
                continue;
              }

              // VT amount = Asset Value (ADA) / Current VT Price (ADA per VT)
              const vtAmountRaw = assetValueAda / currentVtPrice;
              vtAmount = Math.floor(vtAmountRaw * 1_000_000).toString(); // Convert to lovelace equivalent (6 decimals)
            }

            if (vtAmount === '0') {
              this.logger.warn(
                `Calculated VT amount is 0 for transaction ${transaction.id} with ${assetValueAda} ADA value`
              );
              continue;
            }

            // Create expansion claim
            const claimData = {
              user: { id: transaction.user.id },
              vault: { id: vault.id },
              transaction: { id: transaction.id },
              type: ClaimType.EXPANSION,
              status: ClaimStatus.PENDING,
              amount: Number(vtAmount),
              description: `Expansion contribution: ${transaction.assets.length} asset(s) → ${Number(vtAmount) / 1_000_000} VT`,
              metadata: {
                expansionProposalId: expansionProposal.id,
                pricingMethod: expansionConfig.priceType,
                limitPrice: expansionConfig.limitPrice,
                marketPrice: expansionConfig.priceType === 'market' ? vault.vt_price : undefined,
                assetCount: transaction.assets.length,
                assetValueAda,
                calculatedAt: new Date().toISOString(),
                assets: transaction.assets.map(asset => ({
                  id: asset.id,
                  policyId: asset.policy_id,
                  assetId: asset.asset_id,
                  name: asset.name,
                })),
              },
            };

            const claim = this.claimRepository.create(claimData);

            createdClaims.push(claim);
            contributedAssets.push(...transaction.assets);

            this.logger.log(
              `Created expansion claim for user ${transaction.user_id}: ${assetValueAda} ADA → ${Number(vtAmount) / 1_000_000} VT`
            );
          } catch (error) {
            this.logger.error(`Error creating claim for transaction ${transaction.id}: ${error.message}`, error.stack);
          }
        }

        // Save all claims in bulk
        if (createdClaims.length > 0) {
          await this.claimRepository.save(createdClaims);
          this.logger.log(`Successfully created ${createdClaims.length} expansion claim(s) for vault ${vault.id}`);

          // Calculate and update multipliers for expansion assets
          const expansionMultipliers = await this.calculateExpansionMultipliers(
            contributedAssets,
            expansionConfig.priceType === 'limit' ? expansionConfig.limitPrice : vault.vt_price
          );

          // Update vault with new multipliers (append to existing acquire_multiplier)
          await this.updateVaultMultipliers(vault.id, expansionMultipliers);
        }
      }

      // Close the expansion and return vault to locked status
      await this.closeExpansion(vault.id, expansionProposal.id, 'duration_expired');

      this.logger.log(`Successfully closed expansion for vault ${vault.id}`);
    } catch (error) {
      this.logger.error(
        `Error during expansion->locked transition for vault ${vault.id}: ${error.message}`,
        error.stack
      );
      throw error;
    }
  }

  /**
   * Calculate the ADA value of contributed assets
   */
  private async calculateTotalAssetsValue(assets: Asset[]): Promise<number> {
    let totalValueAda = 0;

    for (const asset of assets) {
      // Use floor price if available (for NFTs)
      if (asset.floor_price && asset.floor_price > 0) {
        totalValueAda += asset.floor_price;
        continue;
      }

      // Use DEX price if available (for FTs)
      if (asset.dex_price && asset.dex_price > 0) {
        totalValueAda += asset.dex_price * asset.quantity; // Multiply by quantity for FTs
        continue;
      }
    }

    return totalValueAda;
  }

  /**
   * Calculate multipliers for expansion assets
   * Groups assets by policy and price, calculates VT multiplier for each group
   */
  private async calculateExpansionMultipliers(
    assets: Asset[],
    vtPrice: number
  ): Promise<[string, string | null, number][]> {
    interface AssetWithData {
      policyId: string;
      assetName: string | null;
      price: number;
      vtAmount: number;
      quantity: number;
    }

    const assetsByPolicyAndPrice = new Map<string, AssetWithData[]>();

    // Collect and group all assets by policy and price
    for (const fullAsset of assets) {
      const price = fullAsset.floor_price || fullAsset.dex_price || 0;
      if (price === 0) continue;

      // Calculate VT amount for this asset
      const vtPerAsset = (price / vtPrice) * 1_000_000; // VT in lovelace units
      const quantity = fullAsset.quantity || 1;

      const groupKey = `${fullAsset.policy_id}:${price}`;

      if (!assetsByPolicyAndPrice.has(groupKey)) {
        assetsByPolicyAndPrice.set(groupKey, []);
      }

      assetsByPolicyAndPrice.get(groupKey)!.push({
        policyId: fullAsset.policy_id,
        assetName: fullAsset.asset_id || null,
        price,
        vtAmount: vtPerAsset,
        quantity,
      });
    }

    // Group by policy to determine if we can use policy-level multipliers
    const policiesData = new Map<
      string,
      {
        priceGroups: Map<number, AssetWithData[]>;
        totalAssets: number;
      }
    >();

    for (const assets of assetsByPolicyAndPrice.values()) {
      const policyId = assets[0].policyId;
      const price = assets[0].price;

      if (!policiesData.has(policyId)) {
        policiesData.set(policyId, {
          priceGroups: new Map(),
          totalAssets: 0,
        });
      }

      const policyData = policiesData.get(policyId)!;
      policyData.priceGroups.set(price, assets);
      policyData.totalAssets += assets.length;
    }

    const expansionMultipliers: [string, string | null, number][] = [];

    // Process each policy
    for (const [policyId, policyData] of policiesData.entries()) {
      // If all assets in this policy have the same price, use policy-level multiplier
      if (policyData.priceGroups.size === 1) {
        const [price, assets] = Array.from(policyData.priceGroups.entries())[0];
        const multiplier = Math.floor(assets[0].vtAmount / price / 1_000_000);

        expansionMultipliers.push([policyId, null, multiplier]);

        this.logger.log(
          `Policy-level multiplier for ${policyId}: ${multiplier} (${assets.length} assets with price ${price})`
        );
      } else {
        // Different prices - need asset-level multipliers
        for (const [price, assets] of policyData.priceGroups.entries()) {
          const multiplier = Math.floor(assets[0].vtAmount / price / 1_000_000);

          for (const asset of assets) {
            expansionMultipliers.push([asset.policyId, asset.assetName, multiplier]);
          }

          this.logger.log(
            `Asset-level multipliers for ${policyId} (price ${price}): ${multiplier} (${assets.length} assets)`
          );
        }
      }
    }

    return expansionMultipliers;
  }

  /**
   * Update vault with new expansion multipliers
   * Appends expansion multipliers to existing acquire_multiplier array
   */
  private async updateVaultMultipliers(
    vaultId: string,
    expansionMultipliers: [string, string | null, number][]
  ): Promise<void> {
    if (expansionMultipliers.length === 0) {
      this.logger.warn(`No expansion multipliers to update for vault ${vaultId}`);
      return;
    }

    // Fetch current vault multipliers
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      select: ['id', 'acquire_multiplier'],
    });

    if (!vault) {
      throw new Error(`Vault ${vaultId} not found`);
    }

    // Append expansion multipliers to existing multipliers
    const currentMultipliers = vault.acquire_multiplier || [];
    const updatedMultipliers = [...currentMultipliers, ...expansionMultipliers];

    await this.vaultRepository.update({ id: vaultId }, { acquire_multiplier: updatedMultipliers });

    this.logger.log(
      `Updated vault ${vaultId} multipliers: added ${expansionMultipliers.length} expansion multipliers (total: ${updatedMultipliers.length})`
    );
  }
}
