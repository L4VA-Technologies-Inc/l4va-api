import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { Proposal } from '@/database/proposal.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { DistributionCalculationService } from '@/modules/distribution/distribution-calculation.service';
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
    private readonly vaultManagingService: VaultManagingService,
    private readonly distributionCalculationService: DistributionCalculationService
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
              end: Date.now() + expansionConfig.duration + 24 * 60 * 60 * 1000, // Add 1 day buffer to ensure on-chain state is updated before accepting contributions
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
   * @param expansionMultipliers - Optional expansion multipliers to include in on-chain update
   */
  async closeExpansion(
    vaultId: string,
    proposalId: string,
    reason: 'duration_expired' | 'asset_max_reached',
    expansionMultipliers: [string, string | null, number][]
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
        acquireMultiplier: expansionMultipliers,
      });

      this.logger.log(`On-chain vault closure successful. TX: ${onChainResult.txHash}`);

      // Update vault status back to LOCKED in database and save merged multipliers
      await this.vaultRepository.update(
        { id: vaultId },
        {
          vault_status: VaultStatus.locked,
          vault_sc_status: SmartContractVaultStatus.SUCCESSFUL,
          expansion_phase_start: null,
          expansion_duration: null,
          last_update_tx_hash: onChainResult.txHash,
          acquire_multiplier: expansionMultipliers,
          distribution_in_progress: true,
          distribution_processed: false,
        }
      );

      this.logger.log(`Vault ${vaultId} status changed back to LOCKED with ${expansionMultipliers.length} multipliers`);

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

        // Get vault decimals once (outside the loop)
        const decimals = vault.ft_token_decimals ?? 6;
        const decimalMultiplier = Math.pow(10, decimals);

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

              // VT amount = Asset Value (ADA) / Limit Price (ADA per VT) * 10^decimals
              const vtAmountRaw = assetValueAda / expansionConfig.limitPrice;
              vtAmount = Math.floor(vtAmountRaw * decimalMultiplier).toString();
            } else {
              // Market price: use current VT price from vault
              const currentVtPrice = vault.vt_price;

              if (!currentVtPrice || currentVtPrice === 0) {
                this.logger.error(`Cannot calculate VT amount: VT price is ${currentVtPrice} for vault ${vault.id}`);
                continue;
              }

              // VT amount = Asset Value (ADA) / Current VT Price (ADA per VT) * 10^decimals
              const vtAmountRaw = assetValueAda / currentVtPrice;
              vtAmount = Math.floor(vtAmountRaw * decimalMultiplier).toString();
            }

            if (vtAmount === '0') {
              this.logger.warn(
                `Calculated VT amount is 0 for transaction ${transaction.id} with ${assetValueAda} ADA value`
              );
              continue;
            }

            const claim = this.claimRepository.create({
              user: { id: transaction.user.id },
              vault: { id: vault.id },
              transaction: { id: transaction.id },
              proposal: { id: expansionProposal.id },
              type: ClaimType.EXPANSION,
              status: ClaimStatus.PENDING,
              amount: Number(vtAmount),
              proposal_id: expansionProposal.id,
              description: `Expansion contribution: ${transaction.assets.length} asset(s) → ${Number(vtAmount) / decimalMultiplier} VT`,
              metadata: {
                assetValueAda,
              },
            });

            createdClaims.push(claim);
            contributedAssets.push(...transaction.assets);

            this.logger.log(
              `Created expansion claim for user ${transaction.user_id}: ${assetValueAda} ADA → ${Number(vtAmount) / decimalMultiplier} VT`
            );
          } catch (error) {
            this.logger.error(`Error creating claim for transaction ${transaction.id}: ${error.message}`, error.stack);
          }
        }

        // Save claims in bulk (to get IDs for multiplier recalculation)
        if (createdClaims.length > 0) {
          // STEP 1: Save claims first to get IDs
          const savedClaims = await this.claimRepository.save(createdClaims);
          this.logger.log(`Saved ${savedClaims.length} initial expansion claim(s) for vault ${vault.id}`);

          // STEP 2: Calculate multipliers and recalculate amounts (now that we have IDs)
          const multiplierResult = this.distributionCalculationService.calculateExpansionMultipliers({
            assets: contributedAssets,
            vtPrice: expansionConfig.priceType === 'limit' ? expansionConfig.limitPrice : vault.vt_price,
            decimals,
          });

          this.logger.log(JSON.stringify(multiplierResult));

          const expansionMultipliers = multiplierResult.multipliers;
          const recalculatedClaimAmounts = multiplierResult.recalculatedClaimAmounts;

          // STEP 3: Apply recalculated amounts to claims
          this.distributionCalculationService.applyRecalculatedAmounts(savedClaims, recalculatedClaimAmounts);

          for (const claim of savedClaims) {
            this.logger.log(
              `Recalculated claim ${claim.id}: ${claim.amount / decimalMultiplier} VT (${recalculatedClaimAmounts.get(claim.id) || 0} base units)`
            );
          }

          // STEP 4: Update claims with final recalculated amounts
          await this.claimRepository.save(savedClaims);
          this.logger.log(`Successfully created ${createdClaims.length} expansion claim(s) for vault ${vault.id}`);

          // Close the expansion and return vault to locked status (with multipliers)
          await this.closeExpansion(vault.id, expansionProposal.id, 'duration_expired', expansionMultipliers);
        } else {
          // No contributions, close without multipliers
          await this.closeExpansion(vault.id, expansionProposal.id, 'duration_expired', []);
        }
      } else {
        // No contributions, close without multipliers
        await this.closeExpansion(vault.id, expansionProposal.id, 'duration_expired', []);
      }

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
}
