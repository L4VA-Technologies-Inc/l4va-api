import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Repository } from 'typeorm';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { Proposal } from '@/database/proposal.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { AlertsService } from '@/modules/alerts/alerts.service';
import { DexHunterPricingService } from '@/modules/dexhunter/dexhunter-pricing.service';
import { DistributionCalculationService } from '@/modules/distribution/distribution-calculation.service';
import { TransactionsService } from '@/modules/vaults/processing-tx/offchain-tx/transactions.service';
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
    private readonly distributionCalculationService: DistributionCalculationService,
    private readonly alertsService: AlertsService,
    private readonly transactionsService: TransactionsService,
    private readonly dexHunterPricingService: DexHunterPricingService
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

      // Update vault status back to LOCKED in database and save merged multipliers
      // Clear expansion phase fields to indicate expansion is complete
      await this.vaultRepository.update(
        { id: vaultId },
        {
          vault_status: VaultStatus.locked,
          vault_sc_status: SmartContractVaultStatus.SUCCESSFUL,
          last_update_tx_hash: onChainResult.txHash,
          acquire_multiplier: expansionMultipliers,
          distribution_in_progress: true,
          distribution_processed: false,
          expansion_phase_start: null,
          expansion_duration: null,
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
  async executeExpansionToLockedTransition(
    vault: Pick<Vault, 'id' | 'vault_status' | 'expansion_phase_start' | 'vt_price' | 'ft_token_decimals'>
  ): Promise<void> {
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

    // Determine the reason for closing expansion
    const expansionConfig = expansionProposal.metadata?.expansion;
    let closeReason: 'duration_expired' | 'asset_max_reached' = 'duration_expired';

    if (expansionConfig && !expansionConfig.noMax && expansionConfig.assetMax) {
      const currentAssetCount = expansionConfig.currentAssetCount || 0;
      if (currentAssetCount >= expansionConfig.assetMax) {
        closeReason = 'asset_max_reached';
        this.logger.log(`Expansion closing due to asset max reached: ${currentAssetCount}/${expansionConfig.assetMax}`);
      }
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
              // Limit price: fixed VT per asset unit (NFTs count as 1, FTs use their quantity)
              if (
                !expansionConfig.limitPrice ||
                expansionConfig.limitPrice <= 0 ||
                !Number.isFinite(expansionConfig.limitPrice)
              ) {
                this.logger.error(
                  `Invalid limit price for expansion proposal ${expansionProposal.id}: ${expansionConfig.limitPrice}`
                );
                continue;
              }

              // Calculate total quantity: NFTs count as 1 each, FTs use their quantity
              const totalQuantity = this.calculateTotalQuantity(transaction.assets);

              // VT amount = Limit Price (VT per unit) * total quantity * 10^decimals
              const vtAmountRaw = expansionConfig.limitPrice * totalQuantity;

              // Validate result before using it
              if (!Number.isFinite(vtAmountRaw) || vtAmountRaw < 0) {
                this.logger.error(
                  `Invalid VT calculation result for transaction ${transaction.id}: ${vtAmountRaw} (totalQuantity: ${totalQuantity}, limitPrice: ${expansionConfig.limitPrice})`
                );
                continue;
              }

              vtAmount = Math.floor(vtAmountRaw * decimalMultiplier).toString();
            } else {
              // Market price: use current VT price from vault
              const currentVtPrice = Number(vault.vt_price);

              if (!currentVtPrice || !Number.isFinite(currentVtPrice)) {
                this.logger.error(`Cannot calculate VT amount: VT price is ${currentVtPrice} for vault ${vault.id}`);
                continue;
              }

              // VT amount = Asset Value (ADA) / Current VT Price (ADA per VT) * 10^decimals
              const vtAmountRaw = assetValueAda / currentVtPrice;

              // Validate result before using it
              if (!Number.isFinite(vtAmountRaw) || vtAmountRaw < 0) {
                this.logger.error(
                  `Invalid VT calculation result for transaction ${transaction.id}: ${vtAmountRaw} (assetValueAda: ${assetValueAda}, vtPrice: ${currentVtPrice})`
                );
                continue;
              }

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

          // STEP 2: Validate vtPrice before calculating multipliers
          const vtPrice = expansionConfig.priceType === 'limit' ? expansionConfig.limitPrice : Number(vault.vt_price);

          if (!vtPrice || !Number.isFinite(vtPrice)) {
            this.logger.error(
              `CRITICAL: Invalid vtPrice (${vtPrice}) for expansion multiplier calculation on vault ${vault.id}. ` +
                `Expansion config: ${JSON.stringify({
                  priceType: expansionConfig.priceType,
                  limitPrice: expansionConfig.limitPrice,
                  vaultVtPrice: vault.vt_price,
                })}`
            );

            // Send Slack alert for manual intervention
            await this.alertsService.sendAlert('expansion_invalid_vtprice', {
              vaultId: vault.id,
              proposalId: expansionProposal.id,
              vtPrice,
              priceType: expansionConfig.priceType,
              limitPrice: expansionConfig.limitPrice,
              vaultVtPrice: vault.vt_price,
              claimCount: savedClaims.length,
              contributedAssetsCount: contributedAssets.length,
              closeReason,
            });

            // Set vault to manual distribution mode for admin review
            await this.vaultRepository.update({ id: vault.id }, { manual_distribution_mode: true });

            // Close expansion without multipliers (safe fallback)
            await this.closeExpansion(vault.id, expansionProposal.id, closeReason, []);

            this.logger.warn(
              `Vault ${vault.id} closed without multipliers and set to manual distribution mode due to invalid vtPrice. ` +
                `Administrator must manually review and update vault multipliers.`
            );
            return;
          }

          // STEP 3: Calculate multipliers and recalculate amounts (now that we have IDs)
          const multiplierResult = this.distributionCalculationService.calculateExpansionMultipliers({
            assets: contributedAssets,
            vtPrice,
            decimals,
            priceType: expansionConfig.priceType,
          });

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
          await this.closeExpansion(vault.id, expansionProposal.id, closeReason, expansionMultipliers);
        } else {
          // No contributions, close without multipliers
          await this.closeExpansion(vault.id, expansionProposal.id, closeReason, []);
        }
      } else {
        // No contributions, close without multipliers
        await this.closeExpansion(vault.id, expansionProposal.id, closeReason, []);
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
    // Use the new Asset getter methods for clean, centralized logic
    return assets.reduce((sum, asset) => sum + asset.valueAda, 0);
  }

  /**
   * Calculate the total quantity of contributed assets
   * NFTs count as 1 each, FTs use their normalized quantity
   */
  private calculateTotalQuantity(assets: Asset[]): number {
    return assets.reduce((sum, asset) => sum + asset.normalizedQuantity, 0);
  }

  /**
   * Execute acquire expansion proposal
   * Opens time-limited window for users to send ADA → receive newly minted VTs
   * Changes vault status to EXPANSION and updates on-chain metadata
   */
  async executeAcquireExpansion(proposal: Proposal): Promise<boolean> {
    if (!proposal.metadata?.acquireExpansion) {
      this.logger.warn(`Acquire expansion proposal ${proposal.id} has no acquireExpansion configuration`);
      return false;
    }

    try {
      const expansionConfig = proposal.metadata.acquireExpansion;

      // Fetch full vault data for on-chain update and validation
      const vault = await this.vaultRepository.findOne({
        where: { id: proposal.vaultId },
        select: [
          'id',
          'asset_vault_name',
          'privacy',
          'contribution_phase_start',
          'contribution_duration',
          'value_method',
          'allow_acquire_expansion',
        ],
      });

      if (!vault) {
        throw new Error(`Vault ${proposal.vaultId} not found`);
      }

      if (!vault.allow_acquire_expansion) {
        throw new Error(`Vault ${proposal.vaultId} does not allow acquire expansion`);
      }

      // Update vault metadata on-chain (OPEN status for acquire transactions)
      // For acquire expansion: close asset_window, open acquire_window
      const onChainResult = await this.vaultManagingService.updateVaultMetadataTx({
        vault,
        vaultStatus: SmartContractVaultStatus.OPEN,
        asset_window: {
          start: Date.now(),
          end: Date.now(), // Close asset window for acquire expansion
        },
        acquire_window: expansionConfig.noLimit
          ? {
              start: Date.now(),
              end: Date.now() + 365 * 24 * 60 * 60 * 1000, // Set to 1 year for no limit (effectively infinite)
            }
          : {
              start: Date.now(),
              end: Date.now() + expansionConfig.duration + 24 * 60 * 60 * 1000, // Add 1 day buffer
            },
      });

      // Update vault status to ACQUIRE_EXPANSION in database
      await this.vaultRepository.update(
        { id: proposal.vaultId },
        {
          vault_status: VaultStatus.acquire_expansion,
          vault_sc_status: SmartContractVaultStatus.OPEN,
          expansion_phase_start: new Date(),
          expansion_duration: expansionConfig.noLimit ? 365 * 24 * 60 * 60 * 1000 : expansionConfig.duration,
          last_update_tx_hash: onChainResult.txHash,
        }
      );

      // Emit event for tracking
      this.eventEmitter.emit('proposal.acquire_expansion.executed', {
        proposalId: proposal.id,
        vaultId: proposal.vaultId,
        expansionConfig,
        onChainTxHash: onChainResult.txHash,
      });

      this.logger.log(`Successfully executed acquire expansion proposal ${proposal.id}`);
      return true;
    } catch (error) {
      this.logger.error(`Error executing acquire expansion proposal ${proposal.id}: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Close acquire expansion and return vault to LOCKED status
   * Called when expansion duration expires or max ADA is reached
   * @param newMultiplier - New global multiplier to apply after VT minting
   */
  async closeAcquireExpansion(
    vaultId: string,
    proposalId: string,
    reason: 'duration_expired' | 'max_ada_reached',
    newMultiplier: number
  ): Promise<void> {
    this.logger.log(`Closing acquire expansion for vault ${vaultId}, reason: ${reason}`);

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

      // Update on-chain metadata with new multiplier
      const acquireMultiplier: [string, string | null, number][] = newMultiplier > 0 ? [['', '', newMultiplier]] : [];

      const onChainResult = await this.vaultManagingService.updateVaultMetadataTx({
        vault,
        vaultStatus: SmartContractVaultStatus.SUCCESSFUL,
        acquireMultiplier,
      });

      // Update vault status back to LOCKED in database
      // Clear expansion phase fields to indicate expansion is complete
      await this.vaultRepository.update(
        { id: vaultId },
        {
          vault_status: VaultStatus.locked,
          vault_sc_status: SmartContractVaultStatus.SUCCESSFUL,
          last_update_tx_hash: onChainResult.txHash,
          acquire_multiplier: acquireMultiplier,
          distribution_in_progress: true,
          distribution_processed: false,
          expansion_phase_start: null,
          expansion_duration: null,
        }
      );

      this.logger.log(`Vault ${vaultId} status changed back to LOCKED with new multiplier ${newMultiplier}`);

      // Emit event for tracking
      this.eventEmitter.emit('vault.acquire_expansion.closed', {
        vaultId,
        proposalId,
        reason,
        newMultiplier,
        onChainTxHash: onChainResult.txHash,
      });
    } catch (error) {
      this.logger.error(`Error closing acquire expansion for vault ${vaultId}: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Execute the transition from Expansion to Locked phase for acquire expansion
   * Syncs ADA acquisition transactions, calculates VT amounts, creates acquirer claims
   * Closes the expansion and returns vault to governance (locked) status
   * ADA extraction to treasury happens via automated distribution service cron
   */
  async executeAcquireExpansionToLockedTransition(
    vault: Pick<
      Vault,
      'id' | 'vault_status' | 'expansion_phase_start' | 'vt_price' | 'ft_token_decimals' | 'ft_token_supply'
    >
  ): Promise<void> {
    this.logger.log(`Processing acquire expansion->locked transition for vault ${vault.id}`);

    const expansionProposal = await this.proposalRepository.findOne({
      where: {
        vaultId: vault.id,
        proposalType: ProposalType.ACQUIRE_EXPANSION,
        status: ProposalStatus.EXECUTED,
      },
      order: { executionDate: 'DESC' },
    });

    if (!expansionProposal) {
      this.logger.error(`No executed acquire expansion proposal found for vault ${vault.id}`);
      return;
    }

    // Determine the reason for closing expansion
    const expansionConfig = expansionProposal.metadata?.acquireExpansion;
    let closeReason: 'duration_expired' | 'max_ada_reached' = 'duration_expired';

    if (expansionConfig && !expansionConfig.noMax && expansionConfig.maxAda) {
      const currentAdaRaised = expansionConfig.currentAdaRaised || 0;
      if (currentAdaRaised >= expansionConfig.maxAda) {
        closeReason = 'max_ada_reached';
        this.logger.log(
          `Acquire expansion closing due to max ADA reached: ${currentAdaRaised}/${expansionConfig.maxAda} lovelace`
        );
      }
    }

    try {
      // Sync all transactions for this vault
      await this.transactionsService.syncVaultTransactions(vault.id);

      // Find all acquire transactions during the expansion window with is_expansion flag
      const expansionTransactions = await this.transactionsRepository.find({
        where: {
          vault_id: vault.id,
          type: TransactionType.acquire,
          status: TransactionStatus.confirmed,
          is_expansion: true,
          created_at: MoreThanOrEqual(vault.expansion_phase_start), // Only consider transactions from expansion phase start
        },
        relations: ['user'],
        order: { created_at: 'ASC' },
      });

      this.logger.log(
        `Found ${expansionTransactions.length} acquire expansion transaction(s) during expansion for vault ${vault.id}`
      );

      // Calculate and create VT claims for expansion participants
      if (expansionTransactions.length > 0) {
        const createdClaims: Claim[] = [];
        const decimals = vault.ft_token_decimals ?? 6;
        const decimalMultiplier = Math.pow(10, decimals);

        // Determine VT price based on pricing method
        let vtPrice: number;

        if (expansionConfig.priceType === 'limit') {
          // Limit price: fixed VT per 1 ADA
          vtPrice = expansionConfig.limitPrice;

          if (!vtPrice || vtPrice <= 0 || !Number.isFinite(vtPrice)) {
            this.logger.error(`Invalid limit price for acquire expansion proposal ${expansionProposal.id}: ${vtPrice}`);
            await this.closeAcquireExpansion(vault.id, expansionProposal.id, closeReason, 0);
            return;
          }
        } else {
          // Market price: fetch current VT/ADA price from DexHunter
          // Note: We use the price at extraction time, not the snapshot from proposal creation
          const currentVtPrice = Number(vault.vt_price);

          if (!currentVtPrice || !Number.isFinite(currentVtPrice) || currentVtPrice <= 0) {
            this.logger.error(
              `Cannot calculate VT amount: VT price is ${currentVtPrice} for vault ${vault.id}. Attempting to fetch from DexHunter.`
            );

            // Try to fetch from DexHunter as fallback
            try {
              const vaultWithToken: Pick<Vault, 'script_hash' | 'asset_vault_name'> =
                await this.vaultRepository.findOne({
                  where: { id: vault.id },
                  select: ['script_hash', 'asset_vault_name'],
                });

              if (vaultWithToken.script_hash && vaultWithToken.asset_vault_name) {
                vtPrice = await this.dexHunterPricingService.getTokenPrice(
                  `${vaultWithToken.script_hash}${vaultWithToken.asset_vault_name}`
                );
              } else {
                throw new Error('Vault token not configured');
              }
            } catch (priceError) {
              this.logger.error(`Failed to fetch VT price from DexHunter for vault ${vault.id}: ${priceError.message}`);
              await this.closeAcquireExpansion(vault.id, expansionProposal.id, closeReason, 0);
              return;
            }
          } else {
            vtPrice = currentVtPrice;
          }
        }

        // Process each transaction and calculate VT amounts
        for (const transaction of expansionTransactions) {
          try {
            if (!transaction.user_id) {
              this.logger.warn(`Transaction ${transaction.id} has no user_id, skipping`);
              continue;
            }

            // Amount is stored in ADA, convert to lovelace for calculation
            const adaSentLovelace = (transaction.amount || 0) * 1_000_000;

            if (adaSentLovelace <= 0) {
              this.logger.warn(`Transaction ${transaction.id} has zero or negative amount, skipping`);
              continue;
            }

            // Calculate VT amount based on pricing method
            let vtAmount: string;

            if (expansionConfig.priceType === 'limit') {
              // Limit: VT = ADA (in ADA) * limitPrice (VT per 1 ADA)
              const vtAmountRaw = transaction.amount * vtPrice;

              if (!Number.isFinite(vtAmountRaw) || vtAmountRaw < 0) {
                this.logger.error(
                  `Invalid VT calculation for transaction ${transaction.id}: ${vtAmountRaw} (ADA: ${transaction.amount}, limitPrice: ${vtPrice})`
                );
                continue;
              }

              vtAmount = Math.floor(vtAmountRaw * decimalMultiplier).toString();
            } else {
              // Market: VT = ADA (in ADA) / vtPrice (ADA per VT)
              const vtAmountRaw = transaction.amount / vtPrice;

              if (!Number.isFinite(vtAmountRaw) || vtAmountRaw < 0) {
                this.logger.error(
                  `Invalid VT calculation for transaction ${transaction.id}: ${vtAmountRaw} (ADA: ${transaction.amount}, vtPrice: ${vtPrice})`
                );
                continue;
              }

              vtAmount = Math.floor(vtAmountRaw * decimalMultiplier).toString();
            }

            if (vtAmount === '0') {
              this.logger.warn(
                `Calculated VT amount is 0 for transaction ${transaction.id} with ${transaction.amount} ADA`
              );
              continue;
            }

            // Check if claim already exists for this transaction
            const claimExists = await this.claimRepository.exists({
              where: { transaction: { id: transaction.id }, type: ClaimType.ACQUIRER },
            });

            if (claimExists) {
              this.logger.log(`Claim already exists for transaction ${transaction.id}, skipping`);
              continue;
            }

            const claim = this.claimRepository.create({
              user: { id: transaction.user_id },
              vault: { id: vault.id },
              transaction: { id: transaction.id },
              proposal: { id: expansionProposal.id },
              type: ClaimType.ACQUIRER,
              status: ClaimStatus.PENDING,
              amount: Number(vtAmount),
              proposal_id: expansionProposal.id,
              description: `Acquire expansion: ${transaction.amount} ADA → ${Number(vtAmount) / decimalMultiplier} VT`,
              is_treasury_claim: true,
              metadata: {
                isExpansion: true,
              } as const,
            });

            createdClaims.push(claim);

            this.logger.log(
              `Created acquire expansion claim for user ${transaction.user_id}: ${transaction.amount} ADA → ${Number(vtAmount) / decimalMultiplier} VT`
            );
          } catch (error) {
            this.logger.error(`Error creating claim for transaction ${transaction.id}: ${error.message}`, error.stack);
          }
        }

        // Save claims
        if (createdClaims.length > 0) {
          await this.claimRepository.save(createdClaims);
          this.logger.log(`Saved ${createdClaims.length} acquire expansion claim(s) for vault ${vault.id}`);

          // Calculate multiplier for on-chain metadata and claims
          // Same logic as FT expansion: (vtPrice × VT_decimals) / ADA_decimals
          // Multiplier represents VT basic units per lovelace
          // Examples:
          //   1 VT (6 dec) per 1 ADA: (1 × 10^6) / 10^6 = 1
          //   50 VT (6 dec) per 1 ADA: (50 × 10^6) / 10^6 = 50
          //   1 VT (8 dec) per 1 ADA: (1 × 10^8) / 10^6 = 100
          const ADA_DECIMALS = 6;
          const vtDecimalMultiplier = Math.pow(10, decimals);
          const adaDecimalMultiplier = Math.pow(10, ADA_DECIMALS);

          let multiplier: number;

          if (expansionConfig.priceType === 'limit') {
            // Limit price: (limitPrice × VT decimals) / ADA decimals
            multiplier = Math.floor((vtPrice * vtDecimalMultiplier) / adaDecimalMultiplier);
          } else {
            // Market price: (1/vtPrice × VT decimals) / ADA decimals
            // vtPrice is ADA per VT, so 1/vtPrice gives VT per ADA
            multiplier = Math.floor(((1 / vtPrice) * vtDecimalMultiplier) / adaDecimalMultiplier);
          }

          this.logger.log(
            `Calculated acquire expansion multiplier for vault ${vault.id}: ${multiplier} ` +
              `(priceType: ${expansionConfig.priceType}, vtPrice: ${vtPrice}, decimals: ${decimals})`
          );

          // Update claims with multiplier
          await this.claimRepository.update({ id: In(createdClaims.map(c => c.id)) }, { multiplier: multiplier });

          // Close expansion with new multiplier
          // This will update on-chain metadata and set vault to LOCKED
          await this.closeAcquireExpansion(vault.id, expansionProposal.id, closeReason, multiplier);

          // Claims are PENDING - automated distribution service will extract ADA to treasury and mint VT
        } else {
          // No valid claims, close without minting
          await this.closeAcquireExpansion(vault.id, expansionProposal.id, closeReason, 0);
        }
      } else {
        // No expansion transactions, close without minting
        await this.closeAcquireExpansion(vault.id, expansionProposal.id, closeReason, 0);
      }

      this.logger.log(`Successfully closed acquire expansion for vault ${vault.id}`);
    } catch (error) {
      this.logger.error(
        `Error during acquire expansion->locked transition for vault ${vault.id}: ${error.message}`,
        error.stack
      );
      throw error;
    }
  }

  /**
   * Get the current multiplier for a vault from acquire_multiplier array
   * Returns 0 if no multiplier exists
   */
  private async getCurrentMultiplier(vaultId: string): Promise<number> {
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      select: ['acquire_multiplier'],
    });

    if (!vault || !vault.acquire_multiplier || vault.acquire_multiplier.length === 0) {
      return 0;
    }

    // acquire_multiplier is [[policy, name, multiplier], ...]
    // For ADA (acquire-only), policy and name are empty strings
    const adaMultiplier = vault.acquire_multiplier.find(m => m[0] === '' && (m[1] === '' || m[1] === null));

    return adaMultiplier ? Number(adaMultiplier[2]) : 0;
  }
}
