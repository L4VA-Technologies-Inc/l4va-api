import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { TokenRegistry } from '@/database/tokenRegistry.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { DistributionService } from '@/modules/distribution/distribution.service';
import { TaptoolsService } from '@/modules/taptools/taptools.service';
import { ContributionService } from '@/modules/vaults/phase-management/contribution/contribution.service';
import { TransactionsService } from '@/modules/vaults/processing-tx/offchain-tx/transactions.service';
import { MetadataRegistryApiService } from '@/modules/vaults/processing-tx/onchain/metadata-register.service';
import { VaultManagingService } from '@/modules/vaults/processing-tx/onchain/vault-managing.service';
import { AssetOriginType } from '@/types/asset.types';
import { ClaimStatus, ClaimType } from '@/types/claim.types';
import { TokenRegistryStatus } from '@/types/tokenRegistry.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';
import {
  VaultStatus,
  ContributionWindowType,
  InvestmentWindowType,
  SmartContractVaultStatus,
} from '@/types/vault.types';

@Injectable()
export class LifecycleService {
  private readonly logger = new Logger(LifecycleService.name);

  constructor(
    @InjectQueue('phaseTransition')
    private readonly phaseTransitionQueue: Queue,
    @InjectRepository(Asset)
    private readonly assetsRepository: Repository<Asset>,
    @InjectRepository(Transaction)
    private readonly transactionsRepository: Repository<Transaction>,
    @InjectRepository(Claim)
    private readonly claimRepository: Repository<Claim>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(TokenRegistry)
    private readonly tokenRegistryRepository: Repository<TokenRegistry>,
    private readonly contributionService: ContributionService,
    private readonly vaultManagingService: VaultManagingService,
    private readonly transactionsService: TransactionsService,
    private readonly distributionService: DistributionService,
    private readonly taptoolsService: TaptoolsService,
    private readonly metadataRegistryApiService: MetadataRegistryApiService,
    private readonly eventEmitter: EventEmitter2
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleVaultLifecycleTransitions(): Promise<void> {
    await this.handlePublishedToContribution(); // Handle created vault -> contribution transitin
    await this.handleContributionToAcquire(); // Handle contribution -> acquire transitions
    await this.handleAcquireToGovernance(); // Handle acquire -> governance transitions
  }

  private async queuePhaseTransition(
    vaultId: string,
    newStatus: VaultStatus,
    transitionTime: Date,
    phaseStartField?: 'contribution_phase_start' | 'acquire_phase_start' | 'governance_phase_start'
  ): Promise<void> {
    const now = new Date();
    const delay = transitionTime.getTime() - now.getTime();
    const ONE_MINUTE_MS = 60 * 1000;

    if (delay <= 0) {
      // If transition time is now or in the past, execute immediately
      let scStatus: SmartContractVaultStatus | undefined;

      if (newStatus === VaultStatus.locked) {
        scStatus = SmartContractVaultStatus.SUCCESSFUL;
      } else if (newStatus === VaultStatus.contribution || newStatus === VaultStatus.acquire) {
        scStatus = SmartContractVaultStatus.OPEN;
      } else if (newStatus === VaultStatus.failed) {
        scStatus = SmartContractVaultStatus.CANCELLED;

        const { name, owner } = await this.vaultRepository.findOneBy({ id: vaultId });
        this.eventEmitter.emit('vault.failed', {
          address: owner.address,
          vaultName: name,
        });
      } else {
        scStatus = undefined;
      }

      await this.executePhaseTransition({ vaultId, newStatus, phaseStartField, newScStatus: scStatus });
    } else if (delay <= ONE_MINUTE_MS && newStatus !== VaultStatus.locked) {
      // If transition should happen within the next minute, create a precise delay job
      await this.phaseTransitionQueue.add(
        'transitionPhase',
        {
          vaultId,
          newStatus,
          phaseStartField,
        },
        {
          delay,
          // Remove any existing jobs for this vault and phase to avoid duplicates
          jobId: `${vaultId}-${newStatus}`,
          removeOnComplete: 10,
          removeOnFail: 10,
        }
      );
      this.logger.log(
        `Queued precise phase transition for vault ${vaultId} to ${newStatus} ` +
          `in ${Math.round(delay / 1000)} seconds`
      );
    } else {
      // If more than 1 minute away, don't queue - let future cron runs handle it
    }
  }

  private async executePhaseTransition(data: {
    vaultId: string;
    newStatus: VaultStatus;
    phaseStartField?: 'contribution_phase_start' | 'acquire_phase_start' | 'governance_phase_start';
    newScStatus?: SmartContractVaultStatus;
    txHash?: string;
    acquire_multiplier?: [string, string, number][];
    ada_pair_multiplier?: number;
    vtPrice?: number;
  }): Promise<void> {
    try {
      const vault = await this.vaultRepository.findOne({
        where: { id: data.vaultId },
        relations: ['owner'],
      });

      if (!vault) {
        this.logger.error(`Vault ${data.vaultId} not found for phase transition`);
        return;
      }

      vault.vault_status = data.newStatus;

      if (data.phaseStartField) {
        vault[data.phaseStartField] = new Date().toISOString();
      }

      if (data.newStatus === VaultStatus.failed) {
        const pr = await this.tokenRegistryRepository.findOne({
          where: {
            vault: { id: data.vaultId },
            status: TokenRegistryStatus.PENDING,
          },
        });

        if (pr) {
          try {
            await this.metadataRegistryApiService.closePullRequest(
              pr.pr_number,
              `Closing PR automatically because vault ${vault.name} has failed.`
            );
            this.logger.log(`Successfully closed PR #${pr.pr_number} for failed vault ${data.vaultId}`);
          } catch (error) {
            this.logger.error(`Failed to close PR #${pr.pr_number} for vault ${data.vaultId}:`, error);
          }
        }
      }

      if (data.newStatus === VaultStatus.contribution) {
        this.eventEmitter.emit('vault.launched', {
          vaultId: vault.id,
          address: vault.owner.address,
          vaultName: vault.name,
          contributionStartDate: new Date(vault.contribution_phase_start).toLocaleDateString(),
          contributionStartTime: new Date(vault.contribution_phase_start).toLocaleTimeString(),
        });
      }

      if (data.newScStatus === SmartContractVaultStatus.SUCCESSFUL) {
        vault.vault_sc_status = data.newScStatus;
        vault.last_update_tx_hash = data.txHash;
        vault.locked_at = new Date().toISOString();
        vault.ada_pair_multiplier = data.ada_pair_multiplier;
        vault.vt_price = data.vtPrice;
        vault.acquire_multiplier = data.acquire_multiplier;
      } else if (data.newScStatus) {
        vault.vault_sc_status = data.newScStatus;
      }

      if (data.newScStatus === SmartContractVaultStatus.CANCELLED) {
        vault.vault_sc_status = data.newScStatus;
      }

      await this.vaultRepository.save(vault);

      this.logger.log(
        `Executed immediate phase transition for vault ${vault.id} to ${data.newStatus}` +
          (data.phaseStartField ? ` and set ${data.phaseStartField}` : '')
      );
    } catch (error) {
      this.logger.error(`Failed to execute phase transition for vault ${data.vaultId}:`, error);
      throw error;
    }
  }

  private async queueContributionToAcquireTransition(vault: Vault, contributionEnd: Date): Promise<void> {
    // Check if vault has assets before queuing transition
    await this.contributionService.syncContributionTransactions(vault.id);
    const assets = await this.assetsRepository.find({
      where: { vault: { id: vault.id }, deleted: false },
    });
    const hasAssets = assets?.some(asset => !asset.deleted) || false;

    if (!hasAssets) {
      // Queue failure transition
      await this.queuePhaseTransition(vault.id, VaultStatus.failed, contributionEnd);
      return;
    }

    // Determine acquire phase start time based on vault configuration
    let acquireStartTime: Date;
    try {
      if (vault.acquire_open_window_type === InvestmentWindowType.uponAssetWindowClosing) {
        // Start acquire phase immediately when contribution ends
        acquireStartTime = contributionEnd;
      } else if (vault.acquire_open_window_type === InvestmentWindowType.custom && vault.acquire_open_window_time) {
        // Use custom start time, but ensure it's not before contribution ends
        const customTime = new Date(vault.acquire_open_window_time);
        acquireStartTime = customTime > contributionEnd ? customTime : contributionEnd;
      } else {
        this.logger.warn(`Vault ${vault.id} has invalid acquire window configuration`);
        return;
      }
    } catch (error) {
      this.logger.error(
        `queueContributionToAcquireTransition: Failed to queue phase transition for vault ${vault.id}:`,
        error
      );
    }
    await this.queuePhaseTransition(vault.id, VaultStatus.acquire, acquireStartTime, 'acquire_phase_start');
  }

  private async executeContributionToAcquireTransition(vault: Vault): Promise<void> {
    try {
      // Calculate total value of assets in the vault
      const assetsValue = await this.taptoolsService.calculateVaultAssetsValue(vault.id);

      vault.total_assets_cost_ada = assetsValue.totalValueAda;
      vault.total_assets_cost_usd = assetsValue.totalValueUsd;

      // Calculate threshold Price
      vault.require_reserved_cost_ada =
        assetsValue.totalValueAda * (vault.tokens_for_acquires * 0.01) * (vault.acquire_reserve * 0.01);
      vault.require_reserved_cost_usd =
        assetsValue.totalValueUsd * (vault.tokens_for_acquires * 0.01) * (vault.acquire_reserve * 0.01);

      const emitContributionCompleteEvent = async (): Promise<void> => {
        try {
          const assets = await this.assetsRepository.find({
            where: { vault: { id: vault.id }, deleted: false },
          });

          const contributorIds = [...new Set(assets.map(asset => asset.added_by))];
          this.eventEmitter.emit('vault.contribution_complete', {
            vaultId: vault.id,
            vaultName: vault.name,
            totalValueLocked: vault.total_assets_cost_ada || 0,
            contributorIds,
          });
        } catch (error) {
          this.logger.error(`Error emitting contribution complete event for vault ${vault.id}:`, error);
        }
      };

      // For immediate acquire start
      if (vault.acquire_open_window_type === InvestmentWindowType.uponAssetWindowClosing) {
        await this.executePhaseTransition({
          vaultId: vault.id,
          newStatus: VaultStatus.acquire,
          phaseStartField: 'acquire_phase_start',
        });
        await emitContributionCompleteEvent();
      }
      // For custom acquire start time
      else if (vault.acquire_open_window_type === InvestmentWindowType.custom && vault.acquire_open_window_time) {
        const now = new Date();
        const customTime = new Date(vault.acquire_open_window_time);

        if (now >= customTime) {
          await this.executePhaseTransition({
            vaultId: vault.id,
            newStatus: VaultStatus.acquire,
            phaseStartField: 'acquire_phase_start',
          });
          await emitContributionCompleteEvent();
        } else {
          // Queue for the custom time
          await this.queuePhaseTransition(vault.id, VaultStatus.acquire, customTime, 'acquire_phase_start');
        }
      }
    } catch (error) {
      this.logger.error(`Error executing contribution to acquire transition for vault ${vault.id}`, error);
    }
  }

  private async executeAcquireToGovernanceTransition(vault: Vault): Promise<void> {
    try {
      // Sync transactions one more time
      await this.contributionService.syncContributionTransactions(vault.id);

      // 1. First get all relevant transactions for this vault
      // Get all acquisition transactions
      const acquisitionTransactions = await this.transactionsRepository.find({
        where: {
          vault_id: vault.id,
          type: TransactionType.acquire,
          status: TransactionStatus.confirmed,
        },
        relations: ['user'],
      });

      // Get all contribution transactions
      const contributionTransactions = await this.transactionsRepository.find({
        where: {
          vault_id: vault.id,
          type: TransactionType.contribute,
          status: TransactionStatus.confirmed,
        },
        relations: ['user'],
      });

      // Calculate total ADA from acquisitions
      let totalAcquiredAda = 0;
      const userAcquiredAdaMap: Record<string, number> = {};

      // Group acquisition transactions by user for total calculations
      for (const tx of acquisitionTransactions) {
        if (!tx.user_id) continue;

        const adaSent = tx.amount || 0;
        totalAcquiredAda += adaSent;

        // Track total per user for later calculations
        if (!userAcquiredAdaMap[tx.user_id]) {
          userAcquiredAdaMap[tx.user_id] = 0;
        }
        userAcquiredAdaMap[tx.user_id] += adaSent;
      }

      // Calculate total value of contributed assets
      let totalContributedValueAda = 0;
      const contributionValueByTransaction: Record<string, number> = {};
      const userContributedValueMap: Record<string, number> = {};
      const uniqueAssets = new Map<
        string,
        {
          policyId: string;
          assetName: string;
          totalValueAda: number;
          totalQuantity: number;
          userId: string;
          txId: string;
          assetId: string;
        }
      >();

      // Process contributed assets to calculate their value
      for (const tx of contributionTransactions) {
        if (!tx.user_id) continue;

        // Get assets associated with this transaction
        const txAssets = await this.assetsRepository.find({
          where: {
            transaction: { id: tx.id },
            origin_type: AssetOriginType.CONTRIBUTED,
            deleted: false,
          },
        });

        let transactionValueAda = 0;

        // Calculate value of assets in this transaction
        for (const asset of txAssets) {
          const assetKey = `${asset.policy_id}:${asset.asset_id}`;

          try {
            const { priceAda } = await this.taptoolsService.getAssetValue(asset.policy_id, asset.asset_id);
            const quantity = asset.quantity || 1;
            transactionValueAda += priceAda * quantity;

            if (uniqueAssets.has(assetKey)) {
              const existing = uniqueAssets.get(assetKey)!;
              existing.totalValueAda += priceAda * quantity;
              existing.totalQuantity += quantity;
            } else {
              uniqueAssets.set(assetKey, {
                policyId: asset.policy_id,
                assetName: asset.asset_id,
                totalValueAda: priceAda * quantity,
                totalQuantity: quantity,
                userId: tx.user.id,
                txId: tx.id,
                assetId: asset.id,
              });
            }
          } catch (error) {
            this.logger.error(`Error getting price for asset ${asset.policy_id}.${asset.asset_id}:`, error.message);
          }
        }

        // Store value of this transaction
        contributionValueByTransaction[tx.id] = transactionValueAda;
        totalContributedValueAda += transactionValueAda;

        // Track total per user for proportional distribution
        if (!userContributedValueMap[tx.user.id]) {
          userContributedValueMap[tx.user.id] = 0;
        }
        userContributedValueMap[tx.user.id] += transactionValueAda;
      }

      const requiredThresholdAda = totalContributedValueAda * vault.acquire_reserve * 0.01;
      const meetsThreshold = totalAcquiredAda >= requiredThresholdAda;

      vault.total_acquired_value_ada = totalAcquiredAda;
      await this.vaultRepository.save(vault);

      this.logger.log(
        `Total acquired ADA across all users in vault ${vault.id}: ${totalAcquiredAda}, ` +
          `Total contributed value ADA: ${totalContributedValueAda}` +
          `Required: ${requiredThresholdAda} ADA`
      );

      if (meetsThreshold) {
        const vtSupply = vault.ft_token_supply * 10 ** vault.ft_token_decimals || 0;
        // 3. Calculate LP Tokens
        const { lpAdaAmount, lpVtAmount, vtPrice } = await this.distributionService.calculateLpTokens({
          vtSupply,
          totalAcquiredAda,
          assetsOfferedPercent: vault.tokens_for_acquires * 0.01,
          lpPercent: vault.liquidity_pool_contribution * 0.01,
        });
        // Create LP claim record
        try {
          const lpClaim = await this.claimRepository.findOne({
            where: {
              vault: { id: vault.id },
              type: ClaimType.LP,
            },
          });
          if (!lpClaim) {
            await this.claimRepository.save({
              vault: { id: vault.id },
              type: ClaimType.LP,
              amount: lpVtAmount,
              status: ClaimStatus.AVAILABLE,
            });
            this.logger.log(`Created LP claim for vault owner: ${lpVtAmount} VT tokens (${lpAdaAmount} ADA)`);
          } else {
            this.logger.log(`LP claim already exists for vault ${vault.id}, skipping creation.`);
          }
        } catch (error) {
          this.logger.error(`Failed to create LP claim for vault ${vault.id}:`, error);
        }

        const ASSETS_OFFERED_PERCENT = vault.tokens_for_acquires * 0.01;
        const LP_PERCENT = vault.liquidity_pool_contribution * 0.01;

        // 4. Create claims for each acquisition transaction
        const acquirerClaims: Partial<Claim>[] = [];
        for (const tx of acquisitionTransactions) {
          if (!tx.user || !tx.user.id) continue;

          const userId = tx.user.id;
          const adaSent = tx.amount || 0;

          // Skip transactions with zero amount
          if (adaSent <= 0) continue;

          try {
            // Check if a claim for this transaction already exists
            const existingClaim = await this.claimRepository.findOne({
              where: {
                transaction: { id: tx.id },
                type: ClaimType.ACQUIRER,
              },
            });

            if (existingClaim) {
              this.logger.log(`Claim already exists for acquirer transaction ${tx.id}, skipping.`);
              continue;
            }

            const rawVtReceived = await this.distributionService.calculateAcquirerTokens({
              vaultId: vault.id,
              adaSent,
              numAcquirers: Object.keys(userAcquiredAdaMap).length,
              totalAcquiredValueAda: totalAcquiredAda,
              lpAdaAmount,
              lpVtAmount,
              vtPrice,
              vtSupply,
              ASSETS_OFFERED_PERCENT,
            });

            const multiplier = Math.floor(rawVtReceived / adaSent / 1_000_000);
            const adjustedVtAmount = multiplier * adaSent;

            this.logger.debug(
              `Acquirer ${userId} - Raw VT: ${rawVtReceived}, Multiplier: ${multiplier}, Adjusted VT: ${adjustedVtAmount}`
            );

            // Create claim record for this specific acquisition transaction
            const claim = this.claimRepository.create({
              user: { id: userId },
              vault: { id: vault.id },
              type: ClaimType.ACQUIRER,
              amount: adjustedVtAmount,
              status: ClaimStatus.AVAILABLE,
              transaction: { id: tx.id },
            });
            acquirerClaims.push(claim);
          } catch (error) {
            this.logger.error(`Failed to create acquirer claim for user ${userId} transaction ${tx.id}:`, error);
          }
        }

        if (acquirerClaims.length > 0) {
          try {
            await this.claimRepository.save(acquirerClaims);
          } catch (error) {
            this.logger.error(`Failed to save batch of acquirer claims:`, error);
          }
        }

        // 5. Create claims for each contribution transaction
        const contributorClaims: Partial<Claim>[] = [];
        for (const tx of contributionTransactions) {
          if (!tx.user || !tx.user.id) continue;

          const userId = tx.user.id;
          const txValueAda = contributionValueByTransaction[tx.id] || 0;

          // Skip transactions with zero value
          if (txValueAda <= 0) continue;

          try {
            // Check if a claim for this transaction already exists
            const existingClaim = await this.claimRepository.findOne({
              where: {
                transaction: { id: tx.id },
                type: ClaimType.CONTRIBUTOR,
              },
            });

            if (existingClaim) {
              this.logger.log(`Claim already exists for contributor transaction ${tx.id}, skipping.`);
              continue;
            }

            // Calculate this transaction's proportion of the user's total contribution
            const userTotalValue = userContributedValueMap[userId] || 0;
            const proportionOfUserTotal = userTotalValue > 0 ? txValueAda / userTotalValue : 0;

            // Get total VT tokens for this user based on their total contribution
            const vtRetained = await this.distributionService.calculateContributorTokens({
              valueContributed: userTotalValue,
              totalTvl: totalContributedValueAda,
              lpAdaAmount,
              lpVtAmount,
              vtPrice,
              vtSupply,
              ASSETS_OFFERED_PERCENT,
              LP_PERCENT,
            });

            // Calculate VT tokens for this specific transaction
            const txVtAmount = vtRetained * proportionOfUserTotal;
            this.logger.debug(
              `--- Contributor ${userId} will receive VT: ${txVtAmount} (${proportionOfUserTotal * 100}% of ${vtRetained}) for transaction ${tx.id}`
            );

            // Create claim record for this specific contribution transaction
            const claim = this.claimRepository.create({
              user: { id: userId },
              vault: { id: vault.id },
              type: ClaimType.CONTRIBUTOR,
              amount: Math.floor(txVtAmount),
              status: ClaimStatus.AVAILABLE,
              transaction: { id: tx.id },
            });
            contributorClaims.push(claim);
            this.logger.log(
              `Created contributor claim for user ${userId}: ${txVtAmount} VT tokens for transaction ${tx.id}`
            );
          } catch (error) {
            this.logger.error(`Failed to create contributor claim for user ${userId} transaction ${tx.id}:`, error);
          }
        }

        if (contributorClaims.length > 0) {
          try {
            await this.claimRepository.save(contributorClaims);
          } catch (error) {
            this.logger.error(`Failed to save batch of acquirer claims:`, error);
          }
        }

        const finalContributorClaims = await this.claimRepository.find({
          where: {
            vault: { id: vault.id },
            type: ClaimType.CONTRIBUTOR,
          },
          relations: ['transaction', 'transaction.assets'],
        });
        const finalAcquirerClaims = await this.claimRepository.find({
          where: {
            vault: { id: vault.id },
            type: ClaimType.ACQUIRER,
          },
          relations: ['transaction'],
        });
        const acquireMultiplier = this.distributionService.calculateAcquireMultipliers({
          contributorsClaims: finalContributorClaims,
          acquirerClaims: finalAcquirerClaims,
        });

        // Multiplier for LP
        const { adaPairMultiplier } = this.distributionService.calculateLpAdaMultiplier(lpVtAmount, lpAdaAmount);

        const transaction = await this.transactionsService.createTransaction({
          vault_id: vault.id,
          type: TransactionType.updateVault,
          assets: [], // No assets needed for this transaction as it's metadata update
        });

        const response = await this.vaultManagingService.updateVaultMetadataTx({
          vault,
          transactionId: transaction.id,
          acquireMultiplier,
          adaPairMultiplier,
        });

        await this.executePhaseTransition({
          vaultId: vault.id,
          newStatus: VaultStatus.locked,
          phaseStartField: 'governance_phase_start',
          newScStatus: SmartContractVaultStatus.SUCCESSFUL,
          txHash: response.txHash,
          acquire_multiplier: acquireMultiplier,
          ada_pair_multiplier: adaPairMultiplier,
          vtPrice,
        });

        try {
          this.eventEmitter.emit('distribution.claim_available', {
            vaultId: vault.id,
            vaultName: vault.name,
            tokenHolderIds: [
              ...new Set([...finalAcquirerClaims.map(c => c.user_id), ...finalContributorClaims.map(c => c?.user_id)]),
            ],
          });
        } catch (error) {
          this.logger.error(`Error emitting distribution.claim_available event for vault ${vault.id}:`, error);
        }

        try {
          this.eventEmitter.emit('vault.success', {
            vaultId: vault.id,
            vaultName: vault.name,
            tokenHoldersIds: [
              ...new Set([...finalAcquirerClaims.map(c => c.user_id), ...finalContributorClaims.map(c => c?.user_id)]),
            ],
            adaSpent: totalAcquiredAda,
            tokenPercentage: vault.tokens_for_acquires,
            tokenTicker: vault.vault_token_ticker,
            impliedVaultValue: totalAcquiredAda + totalContributedValueAda,
          });
        } catch (error) {
          this.logger.error(`Error emitting vault.success event for vault ${vault.id}:`, error);
        }
      } else {
        this.logger.warn(
          `Vault ${vault.id} does not meet the threshold: ` +
            `Total contributed: ${totalAcquiredAda} ADA, ` +
            `Required: ${requiredThresholdAda} ADA`
        );

        // TODO: Automatic refund assets
        // const cancelClaims: Partial<Claim>[] = [];

        // for (const tx of [...acquisitionTransactions, ...contributionTransactions]) {
        //   if (!tx.user || !tx.user.id) continue;

        //   const userId = tx.user.id;
        //   const adaSent = tx.amount || 0;

        //   // Skip transactions with zero amount
        //   if (adaSent <= 0) continue;

        //   try {
        //     // Check if a claim for this transaction already exists
        //     const existingClaim = await this.claimRepository.findOne({
        //       where: {
        //         transaction: { id: tx.id },
        //         type: ClaimType.FINAL_DISTRIBUTION,
        //       },
        //     });

        //     if (existingClaim) {
        //       this.logger.log(`Claim already exists for acquirer transaction ${tx.id}, skipping.`);
        //       continue;
        //     }

        //     if (tx.type === TransactionType.contribute) {
        //       // Get assets associated with this transaction
        //       const txAssets = await this.assetsRepository.find({
        //         where: {
        //           transaction: { id: tx.id },
        //           origin_type: AssetOriginType.CONTRIBUTED,
        //           deleted: false,
        //         },
        //       });

        //       // Create claim record with asset information
        //       const claim = this.claimRepository.create({
        //         user: { id: userId },
        //         vault: { id: vault.id },
        //         type: ClaimType.FINAL_DISTRIBUTION,
        //         status: ClaimStatus.AVAILABLE,
        //         metadata: {
        //           assets: txAssets.map(asset => ({
        //             id: asset.id,
        //             policyId: asset.policy_id,
        //             assetId: asset.asset_id,
        //             quantity: asset.quantity,
        //             type: asset.type,
        //           })),
        //           assetIds: txAssets.map(asset => asset.id),
        //           isContribution: true,
        //         },
        //         transaction: { id: tx.id },
        //       });
        //       cancelClaims.push(claim);
        //     }
        //     // For acquisition transactions
        //     else if (tx.type === TransactionType.acquire) {
        //       const claim = this.claimRepository.create({
        //         user: { id: userId },
        //         vault: { id: vault.id },
        //         type: ClaimType.FINAL_DISTRIBUTION,
        //         status: ClaimStatus.AVAILABLE,
        //         metadata: {
        //           adaAmount: tx.amount,
        //           isAcquisition: true,
        //         },
        //         transaction: { id: tx.id },
        //       });
        //       cancelClaims.push(claim);
        //     }
        //   } catch (error) {
        //     this.logger.error(`Failed to create cancel claim for user ${userId} transaction ${tx.id}:`, error);
        //   }
        // }

        // if (cancelClaims.length > 0) {
        //   try {
        //     await this.claimRepository.save(cancelClaims);
        //   } catch (error) {
        //     this.logger.error(`Failed to save batch of acquirer claims:`, error);
        //   }
        // }

        await this.executePhaseTransition({
          vaultId: vault.id,
          newStatus: VaultStatus.failed,
          newScStatus: SmartContractVaultStatus.CANCELLED,
        });

        try {
          this.eventEmitter.emit('vault.failed', {
            vaultId: vault.id,
            vaultName: vault.name,
            contributorIds: [...new Set(contributionTransactions.map(tx => tx.user_id).filter(Boolean))],
          });
        } catch (error) {
          this.logger.error(`Error emitting vault.failed event for vault ${vault.id}:`, error);
        }
      }
    } catch (error) {
      this.logger.error(`Error executing acquire to governance transition for vault ${vault.id}`, error);
    }
  }

  private async handlePublishedToContribution(): Promise<void> {
    // Handle immediate start vaults
    const immediateStartVaults = await this.vaultRepository
      .createQueryBuilder('vault')
      .where('vault.vault_status = :status', { status: VaultStatus.published })
      .andWhere('vault.contribution_open_window_type = :type', { type: ContributionWindowType.uponVaultLaunch })
      .getMany();

    for (const vault of immediateStartVaults) {
      await this.executePhaseTransition({
        vaultId: vault.id,
        newStatus: VaultStatus.contribution,
        phaseStartField: 'contribution_phase_start',
        newScStatus: SmartContractVaultStatus.OPEN,
      });
    }

    // Handle custom start time vaults
    const customStartVaults = await this.vaultRepository
      .createQueryBuilder('vault')
      .where('vault.vault_status = :status', { status: VaultStatus.published })
      .andWhere('vault.contribution_open_window_type = :type', { type: ContributionWindowType.custom })
      .andWhere('vault.contribution_open_window_time IS NOT NULL')
      .getMany();

    for (const vault of customStartVaults) {
      const transitionTime = new Date(vault.contribution_open_window_time);
      await this.queuePhaseTransition(vault.id, VaultStatus.contribution, transitionTime, 'contribution_phase_start');
    }
  }

  private async handleContributionToAcquire(): Promise<void> {
    const now = new Date();
    const contributionVaults = await this.vaultRepository
      .createQueryBuilder('vault')
      .where('vault.vault_status = :status', { status: VaultStatus.contribution })
      .andWhere('vault.contribution_phase_start IS NOT NULL')
      .andWhere('vault.contribution_duration IS NOT NULL')
      .leftJoinAndSelect('vault.owner', 'owner')
      .leftJoinAndSelect('vault.assets_whitelist', 'assetsWhitelist')
      .getMany();

    for (const vault of contributionVaults) {
      const contributionStart = new Date(vault.contribution_phase_start);
      const contributionDurationMs = Number(vault.contribution_duration);
      const contributionEnd = new Date(contributionStart.getTime() + contributionDurationMs);

      // If contribution period hasn't ended yet, queue the transition
      if (now < contributionEnd) {
        await this.queueContributionToAcquireTransition(vault, contributionEnd);
        continue;
      }

      await this.contributionService.syncContributionTransactions(vault.id);

      const assets = await this.assetsRepository.find({
        where: { vault: { id: vault.id }, deleted: false },
        select: ['id', 'policy_id', 'quantity'],
      });

      const policyIdCounts = assets.reduce(
        (counts, asset) => {
          if (!counts[asset.policy_id]) {
            counts[asset.policy_id] = 0;
          }
          counts[asset.policy_id] += asset.quantity || 1;
          return counts;
        },
        {} as Record<string, number>
      );

      let assetsWithinThreshold = true;
      const thresholdViolations: Array<{ policyId: string; count: number; min: number; max: number }> = [];

      if (vault.assets_whitelist && vault.assets_whitelist.length > 0) {
        for (const whitelistItem of vault.assets_whitelist) {
          const policyId = whitelistItem.policy_id;
          const count = policyIdCounts[policyId] || 0;

          if (count < whitelistItem.asset_count_cap_min || count > whitelistItem.asset_count_cap_max) {
            assetsWithinThreshold = false;
            thresholdViolations.push({
              policyId,
              count,
              min: whitelistItem.asset_count_cap_min,
              max: whitelistItem.asset_count_cap_max,
            });
          }
        }

        if (!assetsWithinThreshold) {
          this.logger.warn(
            `Vault ${vault.id} assets do not meet threshold requirements: ${JSON.stringify(thresholdViolations)}`
          );

          const contributionTransactions = await this.transactionsRepository.find({
            where: {
              vault_id: vault.id,
              type: TransactionType.contribute,
              status: TransactionStatus.confirmed,
            },
            relations: ['user'],
          });

          const cancelClaims: Partial<Claim>[] = [];

          for (const tx of contributionTransactions) {
            if (!tx.user || !tx.user.id) continue;

            const userId = tx.user.id;

            try {
              // Check if a claim for this transaction already exists
              const existingClaim = await this.claimRepository.findOne({
                where: {
                  transaction: { id: tx.id },
                  type: ClaimType.FINAL_DISTRIBUTION,
                },
              });

              if (existingClaim) {
                this.logger.log(`Claim already exists for contribution transaction ${tx.id}, skipping.`);
                continue;
              }

              // Get assets associated with this transaction
              const txAssets = await this.assetsRepository.find({
                where: {
                  transaction: { id: tx.id },
                  origin_type: AssetOriginType.CONTRIBUTED,
                  deleted: false,
                },
              });

              // Create claim record with asset information
              const claim = this.claimRepository.create({
                user: { id: userId },
                vault: { id: vault.id },
                type: ClaimType.FINAL_DISTRIBUTION,
                status: ClaimStatus.AVAILABLE,
                metadata: {
                  assets: txAssets.map(asset => ({
                    id: asset.id,
                    policyId: asset.policy_id,
                    assetId: asset.asset_id,
                    quantity: asset.quantity,
                    type: asset.type,
                  })),
                  assetIds: txAssets.map(asset => asset.id),
                  isContribution: true,
                  failureReason: 'threshold_violation',
                  violations: thresholdViolations,
                },
                transaction: { id: tx.id },
              });
              cancelClaims.push(claim);
            } catch (error) {
              this.logger.error(`Failed to create cancel claim for user ${userId} transaction ${tx.id}:`, error);
            }
          }

          if (cancelClaims.length > 0) {
            try {
              await this.claimRepository.save(cancelClaims);
              this.logger.log(`Created ${cancelClaims.length} cancellation claims for failed vault ${vault.id}`);
            } catch (error) {
              this.logger.error(`Failed to save batch of cancellation claims:`, error);
            }
          }
          // If assets don't meet threshold requirements, fail the vault
          await this.executePhaseTransition({
            vaultId: vault.id,
            newStatus: VaultStatus.failed,
            newScStatus: SmartContractVaultStatus.CANCELLED,
          });

          return;
        }
      }
      await this.executeContributionToAcquireTransition(vault);
    }
  }

  private async handleAcquireToGovernance(): Promise<void> {
    const acquireVaults = await this.vaultRepository
      .createQueryBuilder('vault')
      .where('vault.vault_status = :status', { status: VaultStatus.acquire })
      .andWhere('vault.acquire_phase_start IS NOT NULL')
      .andWhere('vault.acquire_window_duration IS NOT NULL')
      .leftJoinAndSelect('vault.owner', 'owner')
      .leftJoinAndSelect('vault.assets', 'assets')
      .getMany();

    const now = new Date();

    for (const vault of acquireVaults) {
      const acquireStart = new Date(vault.acquire_phase_start);
      const acquireDurationMs = Number(vault.acquire_window_duration);
      const acquireEnd = new Date(acquireStart.getTime() + acquireDurationMs);

      // If acquire period hasn't ended yet, queue the transition
      if (now < acquireEnd) {
        await this.queuePhaseTransition(vault.id, VaultStatus.locked, acquireEnd, 'governance_phase_start');
        continue;
      }

      if (now >= acquireEnd) {
        // Execute the transition immediately since the time has passed
        await this.executeAcquireToGovernanceTransition(vault);
      }
    }
  }
}
