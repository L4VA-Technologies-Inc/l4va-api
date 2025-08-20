import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { DistributionService } from '@/modules/distribution/distribution.service';
import { TaptoolsService } from '@/modules/taptools/taptools.service';
import { ContributionService } from '@/modules/vaults/phase-management/contribution/contribution.service';
import { TransactionsService } from '@/modules/vaults/processing-tx/offchain-tx/transactions.service';
import { VaultManagingService } from '@/modules/vaults/processing-tx/onchain/vault-managing.service';
import { AssetOriginType } from '@/types/asset.types';
import { ClaimStatus, ClaimType } from '@/types/claim.types';
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
    private readonly contributionService: ContributionService,
    private readonly vaultManagingService: VaultManagingService,
    private readonly transactionsService: TransactionsService,
    private readonly distributionService: DistributionService,
    private readonly taptoolsService: TaptoolsService
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleVaultLifecycleTransitions(): Promise<void> {
    await this.handlePublishedToContribution();

    // Handle contribution -> acquire transitions
    await this.handleContributionToInvestment();

    // Handle acquire -> governance transitions
    await this.handleInvestmentToGovernance();
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
      this.logger.log(
        `Vault ${vaultId} phase transition to ${newStatus} scheduled in ${Math.round(delay / 1000)} seconds. ` +
          `Will be queued when closer to transition time.`
      );
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
      });

      if (!vault) {
        this.logger.error(`Vault ${data.vaultId} not found for phase transition`);
        return;
      }

      vault.vault_status = data.newStatus;
      if (data.newScStatus !== undefined) {
        vault.vault_sc_status = data.newScStatus;
        vault.last_update_tx_hash = data.txHash;
      }

      if (data.phaseStartField) {
        vault[data.phaseStartField] = new Date().toISOString();
      }

      if (data.ada_pair_multiplier) {
        vault.ada_pair_multiplier = data.ada_pair_multiplier;
      }

      if (data.acquire_multiplier) {
        vault.acquire_multiplier = data.acquire_multiplier;
      }

      if (data.vtPrice) {
        vault.vt_price = data.vtPrice;
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

    await this.queuePhaseTransition(vault.id, VaultStatus.acquire, acquireStartTime, 'acquire_phase_start');
  }

  private async executeContributionToAcquireTransition(vault: Vault): Promise<void> {
    try {
      // Calculate total value of assets in the vault
      const assetsValue = await this.taptoolsService.calculateVaultAssetsValue(vault.id);

      vault.total_assets_cost_ada = assetsValue.totalValueAda;
      vault.total_assets_cost_usd = assetsValue.totalValueUsd;

      // Calculate threshold Price
      vault.require_reserved_cost_ada = assetsValue.totalValueAda * (vault.acquire_reserve * 0.01);
      vault.require_reserved_cost_usd = assetsValue.totalValueUsd * (vault.acquire_reserve * 0.01);

      // For immediate acquire start
      if (vault.acquire_open_window_type === InvestmentWindowType.uponAssetWindowClosing) {
        await this.executePhaseTransition({
          vaultId: vault.id,
          newStatus: VaultStatus.acquire,
          phaseStartField: 'acquire_phase_start',
        });
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

      const requiredThresholdAda = vault.acquire_reserve || 0;
      const meetsThreshold = totalAcquiredAda >= requiredThresholdAda;

      vault.total_acquired_value_ada = totalAcquiredAda;
      await this.vaultRepository.save(vault);

      this.logger.log(
        `Total acquired ADA across all users in vault ${vault.id}: ${totalAcquiredAda}, ` +
          `Total contributed value ADA: ${totalContributedValueAda}` +
          `Required: ${requiredThresholdAda} ADA`
      );

      if (meetsThreshold) {
        // 3. Calculate LP Tokens
        const { lpAdaAmount, lpVtAmount, vtPrice } = await this.distributionService.calculateLpTokens({
          vtSupply: vault.ft_token_supply || 0,
          totalAcquiredAda,
          assetsOfferedPercent: vault.tokens_for_acquires * 0.01,
          lpPercent: vault.liquidity_pool_contribution * 0.01,
        });
        // Create LP claim record
        try {
          await this.claimRepository.save({
            vault: { id: vault.id },
            type: ClaimType.LP,
            amount: lpVtAmount,
            status: ClaimStatus.AVAILABLE,
          });
          this.logger.log(`Created LP claim for vault owner: ${lpVtAmount} VT tokens (${lpAdaAmount} ADA)`);
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

            const vtReceived = await this.distributionService.calculateAcquirerTokens({
              vaultId: vault.id,
              adaSent,
              numAcquirers: Object.keys(userAcquiredAdaMap).length,
              totalAcquiredValueAda: totalAcquiredAda,
              lpAdaAmount,
              lpVtAmount,
              vtPrice,
              VT_SUPPLY: vault.ft_token_supply,
              ASSETS_OFFERED_PERCENT,
            });

            this.logger.debug(
              `--- Acquirer ${userId} will receive VT: ${vtReceived} (for ADA sent: ${adaSent} in tx ${tx.id})`
            );

            // Create claim record for this specific acquisition transaction
            const claim = this.claimRepository.create({
              user: { id: userId },
              vault: { id: vault.id },
              type: ClaimType.ACQUIRER,
              amount: vtReceived,
              status: ClaimStatus.AVAILABLE,
              transaction: { id: tx.id },
            });
            acquirerClaims.push(claim);
            this.logger.log(
              `Created acquirer claim for user ${userId}: ${vtReceived} VT tokens for transaction ${tx.id}`
            );
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
              VT_SUPPLY: vault.ft_token_supply,
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
      } else {
        this.logger.warn(
          `Vault ${vault.id} does not meet the threshold: ` +
            `Total contributed: ${totalAcquiredAda} ADA, ` +
            `Required: ${requiredThresholdAda} ADA`
        );

        // TODO: Burn the vault and refund assets
        this.logger.warn(`Vault ${vault.id} needs to be burned and assets refunded`);
        await this.executePhaseTransition({
          vaultId: vault.id,
          newStatus: VaultStatus.failed,
          newScStatus: SmartContractVaultStatus.CANCELLED,
        });
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

  private async handleContributionToInvestment(): Promise<void> {
    const now = new Date();
    const contributionVaults = await this.vaultRepository
      .createQueryBuilder('vault')
      .where('vault.vault_status = :status', { status: VaultStatus.contribution })
      .andWhere('vault.contribution_phase_start IS NOT NULL')
      .andWhere('vault.contribution_duration IS NOT NULL')
      .leftJoinAndSelect('vault.owner', 'owner')
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

      const assets = await this.assetsRepository.find({ where: { vault: { id: vault.id }, deleted: false } });
      // Check if vault has any non-deleted assets
      const hasAssets = assets?.some(asset => !asset.deleted) || false;

      // If no assets, burn the vault using admin wallet
      if (!hasAssets) {
        try {
          this.logger.log(`Vault ${vault.id} has no assets and contribution period has ended. Burning vault...`);
          // Update vault status to failed
          await this.executePhaseTransition({
            vaultId: vault.id,
            newStatus: VaultStatus.failed,
            newScStatus: SmartContractVaultStatus.CANCELLED,
          });

          // // Use admin wallet to burn the vault
          // const burnTx = await this.vaultContractService.createBurnTx({
          //   customerAddress: vault.owner.address, // Still track the original owner
          //   assetVaultName: vault.asset_vault_name,
          // });

          // // Submit the transaction using admin wallet
          // const { txHash } = await this.vaultContractService.submitOnChainVaultTx({
          //   transaction: burnTx.presignedTx,
          //   signatures: [], // Admin signature is already included in presignedTx
          // });

          // // Update vault status
          // vault.deleted = true;
          // vault.liquidation_hash = txHash;
          // await this.vaultRepository.save(vault);

          // this.logger.log(`Successfully burned empty vault ${vault.id} in transaction ${txHash}`);

          continue;
        } catch (error) {
          this.logger.error(`Failed to burn empty vault ${vault.id}:`, error.message);
          // Continue with other vaults even if one fails
        }
        continue;
      }

      // If we get here, the vault has assets and the contribution period has ended
      // Execute the transition immediately since the time has passed
      await this.executeContributionToAcquireTransition(vault);
    }
  }

  private async handleInvestmentToGovernance(): Promise<void> {
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
