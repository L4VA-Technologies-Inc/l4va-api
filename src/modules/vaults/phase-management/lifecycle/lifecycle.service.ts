import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { ClaimsService } from '../../claims/claims.service';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { TokenRegistry } from '@/database/tokenRegistry.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { DistributionCalculationService } from '@/modules/distribution/distribution-calculation.service';
import { TaptoolsService } from '@/modules/taptools/taptools.service';
import { ContributionService } from '@/modules/vaults/phase-management/contribution/contribution.service';
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
  private readonly processingVaults = new Set<string>(); // Track vaults currently being processed

  constructor(
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
    private readonly distributionCalculationService: DistributionCalculationService,
    private readonly taptoolsService: TaptoolsService,
    private readonly metadataRegistryApiService: MetadataRegistryApiService,
    private readonly claimsService: ClaimsService,
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
    } else if (delay <= ONE_MINUTE_MS) {
      // Refactor queue to execute with validation, not just changing status
      // If transition should happen within the next minute, create a precise delay job
      // await this.phaseTransitionQueue.add(
      //   'transitionPhase',
      //   {
      //     vaultId,
      //     newStatus,
      //     phaseStartField,
      //   },
      //   {
      //     delay,
      //     // Remove any existing jobs for this vault and phase to avoid duplicates
      //     jobId: `${vaultId}-${newStatus}`,
      //     removeOnComplete: 10,
      //     removeOnFail: 10,
      //   }
      // );
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
    fdv?: number;
    fdvTvl?: number;
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

        this.eventEmitter.emit('vault.launched.email', {
          vault,
        });

        this.eventEmitter.emit('vault.phase.email', {
          vault,
          phaseStatus: 'launched',
        });
      } else if (data.newStatus === VaultStatus.acquire) {
        this.eventEmitter.emit('vault.phase.email', {
          vault,
          phaseStatus: 'launched',
        });
      } else if (data.newStatus === VaultStatus.locked) {
        this.eventEmitter.emit('vault.phase.email', {
          vault,
          phaseStatus: 'launched',
        });
      }

      if (data.newScStatus === SmartContractVaultStatus.SUCCESSFUL) {
        vault.vault_sc_status = data.newScStatus;
        vault.last_update_tx_hash = data.txHash;
        vault.locked_at = new Date().toISOString();
        vault.ada_pair_multiplier = data.ada_pair_multiplier;
        vault.vt_price = data.vtPrice;
        vault.acquire_multiplier = data.acquire_multiplier;
        vault.fdv = data.fdv;
        vault.fdv_tvl = data.fdvTvl;
      } else if (data.newScStatus) {
        vault.vault_sc_status = data.newScStatus;
      }

      if (data.newScStatus === SmartContractVaultStatus.CANCELLED) {
        vault.vault_sc_status = data.newScStatus;
        vault.last_update_tx_hash = data.txHash;
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

  // private async queueContributionToAcquireTransition(vault: Vault, contributionEnd: Date): Promise<void> {
  //   // Check if vault has assets before queuing transition
  //   await this.contributionService.syncContributionTransactions(vault.id);
  //   const assets = await this.assetsRepository.find({
  //     where: { vault: { id: vault.id }, deleted: false },
  //   });
  //   const hasAssets = assets?.some(asset => !asset.deleted) || false;

  //   if (!hasAssets) {
  //     // Queue failure transition
  //     await this.queuePhaseTransition(vault.id, VaultStatus.failed, contributionEnd);
  //     return;
  //   }

  //   // Determine acquire phase start time based on vault configuration
  //   let acquireStartTime: Date;
  //   try {
  //     if (vault.acquire_open_window_type === InvestmentWindowType.uponAssetWindowClosing) {
  //       // Start acquire phase immediately when contribution ends
  //       acquireStartTime = contributionEnd;
  //     } else if (vault.acquire_open_window_type === InvestmentWindowType.custom && vault.acquire_open_window_time) {
  //       // Use custom start time, but ensure it's not before contribution ends
  //       const customTime = new Date(vault.acquire_open_window_time);
  //       acquireStartTime = customTime > contributionEnd ? customTime : contributionEnd;
  //     } else {
  //       this.logger.warn(`Vault ${vault.id} has invalid acquire window configuration`);
  //       return;
  //     }
  //   } catch (error) {
  //     this.logger.error(
  //       `queueContributionToAcquireTransition: Failed to queue phase transition for vault ${vault.id}:`,
  //       error
  //     );
  //   }
  //   // await this.queuePhaseTransition(vault.id, VaultStatus.acquire, acquireStartTime, 'acquire_phase_start');
  // }

  private async handlePublishedToContribution(): Promise<void> {
    // Handle immediate start vaults
    const immediateStartVaults = await this.vaultRepository
      .createQueryBuilder('vault')
      .where('vault.vault_status = :status', { status: VaultStatus.published })
      .andWhere('vault.contract_address IS NOT NULL')
      .andWhere('vault.contract_address != :testAddress', {
        testAddress: 'addr_test1wr7cjttpkldnfyxhnw8anc3yye8rwp8ek5zpha7vxk2sl5svh2ceg', // SC address, not vault address
      })
      .andWhere('vault.contribution_open_window_type = :type', { type: ContributionWindowType.uponVaultLaunch })
      .getMany();

    for (const vault of immediateStartVaults) {
      try {
        this.metadataRegistryApiService.submitVaultTokenMetadata({
          vaultId: vault.id,
          subject: `${vault.script_hash}${vault.asset_vault_name}`,
          name: vault.name,
          description: vault.description,
          ticker: vault.vault_token_ticker,
          logo: vault.ft_token_img?.file_url || '',
          decimals: vault.ft_token_decimals,
        });
      } catch (error) {
        this.logger.error('Error updating vault metadata:', error);
      }

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
      .andWhere('vault.contract_address IS NOT NULL')
      .andWhere('vault.contract_address != :testAddress', {
        testAddress: 'addr_test1wr7cjttpkldnfyxhnw8anc3yye8rwp8ek5zpha7vxk2sl5svh2ceg',
      })
      .getMany();

    for (const vault of customStartVaults) {
      const transitionTime = new Date(vault.contribution_open_window_time);
      await this.queuePhaseTransition(vault.id, VaultStatus.contribution, transitionTime, 'contribution_phase_start');
    }
  }

  /**
   * Handles transition from Contribution phase to Acquire phase.
   *
   * Validation scenarios:
   *
   * Scenario 1: Vault has assets, policy has 1 asset, min=1, max=5 → ✅ PASS (soft requirement, within max)
   *
   * Scenario 2: Vault has assets, policy has 0 assets, min=1, max=5 → ✅ PASS (soft requirement ignores min)
   *
   * Scenario 3: Vault has assets, policy has 6 assets, min=1, max=5 → ❌ FAIL (exceeds maximum)
   *
   * Scenario 4: Vault has assets, policy has 1 asset, min=2, max=5 → ❌ FAIL (below required minimum)
   *
   *  Scenario 5: Vault has no assets, any policy → ALL THRESHOLDS ENFORCED
   */
  private async handleContributionToAcquire(): Promise<void> {
    const now = new Date();

    const contributionVaults = await this.vaultRepository
      .createQueryBuilder('vault')
      .where('vault.vault_status = :status', { status: VaultStatus.contribution })
      .andWhere('vault.contribution_phase_start IS NOT NULL')
      .andWhere('vault.contribution_duration IS NOT NULL')
      .andWhere(`vault.contribution_phase_start + (vault.contribution_duration * interval '1 millisecond') <= :now`, {
        now,
      })
      .leftJoinAndSelect('vault.owner', 'owner')
      .leftJoinAndSelect('vault.assets_whitelist', 'assetsWhitelist')
      .leftJoinAndSelect('vault.assets', 'assets', 'assets.deleted = :deleted', { deleted: false })
      .getMany();

    for (const vault of contributionVaults) {
      try {
        this.metadataRegistryApiService.submitVaultTokenMetadata({
          vaultId: vault.id,
          subject: `${vault.script_hash}${vault.asset_vault_name}`,
          name: vault.name,
          description: vault.description,
          ticker: vault.vault_token_ticker,
          logo: vault.ft_token_img?.file_url || '',
          decimals: vault.ft_token_decimals,
        });
      } catch (error) {
        this.logger.error('Error updating vault metadata:', error);
      }

      await this.contributionService.syncContributionTransactions(vault.id);

      const policyIdCounts = vault.assets.reduce(
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

      // Check if vault has at least one asset
      const hasAnyAssets = vault.assets.length > 0;

      if (vault.assets_whitelist && vault.assets_whitelist.length > 0) {
        for (const whitelistItem of vault.assets_whitelist) {
          const policyId = whitelistItem.policy_id;
          const count = policyIdCounts[policyId] || 0;
          const minRequired = whitelistItem.asset_count_cap_min;
          const maxAllowed = whitelistItem.asset_count_cap_max;

          // Apply soft requirement logic:
          // If vault has assets AND min requirement is 1,
          // then skip MINIMUM validation (soft requirement)
          // BUT still enforce MAXIMUM validation
          const isSoftRequirement = hasAnyAssets && minRequired === 1;

          // Check minimum threshold (skip if soft requirement)
          const violatesMinimum = !isSoftRequirement && count < minRequired;

          // Always check maximum threshold (even for soft requirements)
          const violatesMaximum = count > maxAllowed;

          if (violatesMinimum || violatesMaximum) {
            assetsWithinThreshold = false;
            thresholdViolations.push({
              policyId,
              count,
              min: minRequired,
              max: maxAllowed,
            });
          }
        }

        if (!assetsWithinThreshold) {
          this.logger.warn(
            `Vault ${vault.id} assets do not meet threshold requirements: ${JSON.stringify(thresholdViolations)}`
          );

          const response = await this.vaultManagingService.updateVaultMetadataTx({
            vault,
            vaultStatus: SmartContractVaultStatus.CANCELLED,
          });
          await this.claimsService.createCancellationClaims(vault, 'threshold_violation');
          await this.executePhaseTransition({
            vaultId: vault.id,
            newStatus: VaultStatus.failed,
            newScStatus: SmartContractVaultStatus.CANCELLED,
            txHash: response.txHash,
          });

          return;
        }
      }

      // Check if vault should skip acquire phase (Acquirers % = 0%)
      if (Number(vault.tokens_for_acquires) === 0) {
        this.logger.log(
          `Vault ${vault.id} has 0% tokens for acquirers. ` +
            `Skipping acquire phase and transitioning directly to governance.`
        );

        // Calculate distributions without acquire phase
        // FDV = TVL of contributed assets
        // All VT goes to contributors (minus LP if ADA was contributed)

        // Skip to governance immediately after contribution window ends
        await this.executeContributionDirectToGovernance(vault);
        return;
      } else {
        await this.executeContributionToAcquireTransition(vault);
      }
    }
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

  // Acquire to Governance Transition

  private async handleAcquireToGovernance(): Promise<void> {
    const now = new Date();

    const acquireVaults = await this.vaultRepository
      .createQueryBuilder('vault')
      .where('vault.vault_status = :status', { status: VaultStatus.acquire })
      .andWhere('vault.acquire_phase_start IS NOT NULL')
      .andWhere('vault.acquire_window_duration IS NOT NULL')
      .andWhere(`vault.acquire_phase_start + (vault.acquire_window_duration * interval '1 millisecond') <= :now`, {
        now,
      })
      .andWhere('vault.id NOT IN (:...processingIds)', {
        processingIds:
          this.processingVaults.size > 0 ? Array.from(this.processingVaults) : ['00000000-0000-0000-0000-000000000000'], // Dummy UUID to avoid empty array
      })
      .leftJoinAndSelect('vault.owner', 'owner')
      .leftJoinAndSelect('vault.assets', 'assets')
      .getMany();

    if (acquireVaults.length === 0) {
      return;
    }

    for (const vault of acquireVaults) {
      try {
        this.processingVaults.add(vault.id);
        await this.executeAcquireToGovernanceTransition(vault);
      } finally {
        this.processingVaults.delete(vault.id);
      }
    }
  }

  private async executeAcquireToGovernanceTransition(vault: Vault): Promise<void> {
    try {
      try {
        this.metadataRegistryApiService.submitVaultTokenMetadata({
          vaultId: vault.id,
          subject: `${vault.script_hash}${vault.asset_vault_name}`,
          name: vault.name,
          description: vault.description,
          ticker: vault.vault_token_ticker,
          logo: vault.ft_token_img?.file_url || '',
          decimals: vault.ft_token_decimals,
        });
      } catch (error) {
        this.logger.error('Error updating vault metadata:', error);
      }

      // Sync transactions one more time
      await this.contributionService.syncContributionTransactions(vault.id);

      // 1. First get all relevant transactions for this vault
      const allTransactions = await this.transactionsRepository.find({
        where: {
          vault_id: vault.id,
          type: In([TransactionType.acquire, TransactionType.contribute]),
          status: TransactionStatus.confirmed,
        },
        relations: ['user'],
        order: { created_at: 'ASC' },
      });

      const acquisitionTransactions = allTransactions.filter(tx => tx.type === TransactionType.acquire);
      const contributionTransactions = allTransactions.filter(tx => tx.type === TransactionType.contribute);

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

      const requiredThresholdAda =
        totalContributedValueAda * vault.tokens_for_acquires * 0.01 * vault.acquire_reserve * 0.01;
      const meetsThreshold = totalAcquiredAda >= requiredThresholdAda;

      await this.vaultRepository.update({ id: vault.id }, { total_acquired_value_ada: totalAcquiredAda });

      this.logger.log(
        `Total acquired ADA across all users in vault ${vault.id}: ${totalAcquiredAda}, ` +
          `Total contributed value ADA: ${totalContributedValueAda}` +
          `Required: ${requiredThresholdAda} ADA`
      );

      if (meetsThreshold) {
        const vtSupply = vault.ft_token_supply * 10 ** vault.ft_token_decimals || 0;
        const ASSETS_OFFERED_PERCENT = vault.tokens_for_acquires * 0.01;
        const LP_PERCENT = vault.liquidity_pool_contribution * 0.01;
        // 3. Calculate LP Tokens
        const { lpAdaAmount, lpVtAmount, vtPrice, fdv, adjustedVtLpAmount, adaPairMultiplier } =
          this.distributionCalculationService.calculateLpTokens({
            vtSupply,
            totalAcquiredAda,
            totalContributedValueAda,
            assetsOfferedPercent: ASSETS_OFFERED_PERCENT,
            lpPercent: LP_PERCENT,
          });
        try {
          const lpClaimExists = await this.claimRepository.exists({
            where: {
              vault: { id: vault.id },
              type: ClaimType.LP,
            },
          });
          if (!lpClaimExists) {
            await this.claimRepository.save({
              vault: { id: vault.id },
              type: ClaimType.LP,
              amount: adjustedVtLpAmount,
              status: ClaimStatus.AVAILABLE,
              metadata: {
                adaAmount: Math.floor(lpAdaAmount * 1_000_000),
              },
            });
            this.logger.log(
              `Created LP claim for vault owner: ${lpVtAmount} VT tokens, adjusted to ${adjustedVtLpAmount} (${lpAdaAmount} ADA)`
            );
          }
        } catch (error) {
          this.logger.error(`Failed to create LP claim for vault ${vault.id}:`, error);
        }

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
            const claimExists = await this.claimRepository.exists({
              where: {
                transaction: { id: tx.id },
                type: ClaimType.ACQUIRER,
              },
            });

            if (claimExists) {
              continue;
            }

            const { vtReceived, multiplier } = this.distributionCalculationService.calculateAcquirerTokens({
              adaSent,
              totalAcquiredValueAda: totalAcquiredAda,
              lpAdaAmount,
              lpVtAmount,
              vtPrice,
              vtSupply,
              ASSETS_OFFERED_PERCENT,
            });

            const claim = this.claimRepository.create({
              user: { id: userId },
              vault: { id: vault.id },
              type: ClaimType.ACQUIRER,
              amount: vtReceived,
              status: ClaimStatus.PENDING,
              transaction: { id: tx.id },
              metadata: {
                multiplier: multiplier,
              },
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
            const claimExists = await this.claimRepository.exists({
              where: {
                transaction: { id: tx.id },
                type: ClaimType.CONTRIBUTOR,
              },
            });

            if (claimExists) {
              continue;
            }

            const userTotalValue = userContributedValueMap[userId] || 0;

            // Single method call to get all values
            const contributorResult = this.distributionCalculationService.calculateContributorTokens({
              txContributedValue: txValueAda,
              userTotalValue,
              totalAcquiredAda,
              totalTvl: totalContributedValueAda,
              lpAdaAmount,
              lpVtAmount,
              vtSupply,
              ASSETS_OFFERED_PERCENT,
            });

            // Create claim with all calculated values
            const claim = this.claimRepository.create({
              user: { id: userId },
              vault: { id: vault.id },
              type: ClaimType.CONTRIBUTOR,
              amount: contributorResult.vtAmount,
              status: ClaimStatus.PENDING, // Move to active after successful Extraction
              transaction: { id: tx.id },
              metadata: {
                adaAmount: contributorResult.adaAmount,
                vtPrice,
                contributedValueAda: txValueAda,
                userTotalValueAda: userTotalValue,
                proportionOfUserTotal: contributorResult.proportionOfUserTotal,
                userTotalVtTokens: contributorResult.userTotalVtTokens,
              },
            });

            contributorClaims.push(claim);
            this.logger.log(
              `Created contributor claim for user ${userId}: ${contributorResult.vtAmount} VT tokens, and ADA ${contributorResult.adaAmount} for transaction ${tx.id}`
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

        const finalClaims = await this.claimRepository.find({
          where: {
            vault: { id: vault.id },
            type: In([ClaimType.CONTRIBUTOR, ClaimType.ACQUIRER]),
          },
          relations: ['transaction', 'transaction.assets'],
          order: { created_at: 'ASC' },
        });

        const finalContributorClaims = finalClaims.filter(cl => cl.type === ClaimType.CONTRIBUTOR);
        const finalAcquirerClaims = finalClaims.filter(cl => cl.type === ClaimType.ACQUIRER);

        const { acquireMultiplier, adaDistribution } = this.distributionCalculationService.calculateAcquireMultipliers({
          contributorsClaims: finalContributorClaims,
          acquirerClaims: finalAcquirerClaims,
        });

        const response = await this.vaultManagingService.updateVaultMetadataTx({
          vault,
          acquireMultiplier,
          adaDistribution,
          adaPairMultiplier,
          vaultStatus: SmartContractVaultStatus.SUCCESSFUL,
        });

        if (!response.txHash) {
          this.logger.error(`Failed to get txHash for vault ${vault.id} metadata update transaction`);
          return;
        }

        await this.executePhaseTransition({
          vaultId: vault.id,
          newStatus: VaultStatus.locked,
          phaseStartField: 'governance_phase_start',
          newScStatus: SmartContractVaultStatus.SUCCESSFUL,
          txHash: response.txHash,
          acquire_multiplier: acquireMultiplier,
          ada_pair_multiplier: adaPairMultiplier,
          vtPrice,
          fdv,
          fdvTvl: +(fdv / totalContributedValueAda).toFixed(2) || 0,
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

        const response = await this.vaultManagingService.updateVaultMetadataTx({
          vault,
          vaultStatus: SmartContractVaultStatus.CANCELLED,
        });
        await this.claimsService.createCancellationClaims(vault, 'threshold_not_met');

        await this.executePhaseTransition({
          vaultId: vault.id,
          newStatus: VaultStatus.failed,
          newScStatus: SmartContractVaultStatus.CANCELLED,
          txHash: response.txHash,
        });

        await new Promise(resolve => setTimeout(resolve, 20000)); // Wait until tx confirms

        try {
          this.eventEmitter.emit('vault.failed', {
            vaultId: vault.id,
            vaultName: vault.name,
            contributorIds: [...new Set(contributionTransactions.map(tx => tx.user_id).filter(Boolean))],
          });
          this.eventEmitter.emit('vault.failed.email', { vault });
        } catch (error) {
          this.logger.error(`Error emitting vault.failed event for vault ${vault.id}:`, error);
        }
      }
    } catch (error) {
      this.logger.error(`Error executing acquire to governance transition for vault ${vault.id}`, error);
    }
  }

  /**
   * Handle direct transition from Contribution to Governance (skip Acquire phase)
   * Used when Acquirers % = 0%
   *
   * Flow:
   * - No acquire phase occurs
   * - FDV = TVL of contributed assets
   * - All VT tokens (minus LP) go to contributors
   * - No ADA distribution (no acquirers to distribute from)
   * - Contributors receive VT based on their proportional contribution value
   */
  private async executeContributionDirectToGovernance(vault: Vault): Promise<void> {
    try {
      this.logger.log(
        `Starting direct contribution to governance transition for vault ${vault.id} ` + `(0% for acquirers)`
      );

      await this.contributionService.syncContributionTransactions(vault.id);

      // Calculate total value of contributed assets (this becomes the FDV)
      const assetsValue = await this.taptoolsService.calculateVaultAssetsValue(vault.id);
      const totalContributedValueAda = assetsValue.totalValueAda;

      const vtSupply = vault.ft_token_supply * 10 ** vault.ft_token_decimals || 0;
      const LP_PERCENT = vault.liquidity_pool_contribution * 0.01;

      // Calculate LP tokens with 0% for acquirers
      const { lpAdaAmount, lpVtAmount, vtPrice, fdv, adjustedVtLpAmount, adaPairMultiplier } =
        this.distributionCalculationService.calculateLpTokens({
          vtSupply,
          totalAcquiredAda: 0, // No acquirers
          assetsOfferedPercent: 0, // 0% for acquirers
          lpPercent: LP_PERCENT,
          totalContributedValueAda: totalContributedValueAda,
        });

      this.logger.log(
        `Vault ${vault.id} LP calculation: ` +
          `VT Price: ${vtPrice} ADA, FDV: ${fdv} ADA (= TVL), ` +
          `LP VT: ${lpVtAmount}, LP ADA: ${lpAdaAmount}`
      );

      // Create LP claim if applicable
      if (adjustedVtLpAmount > 0 && lpAdaAmount > 0) {
        const lpClaimExists = await this.claimRepository.exists({
          where: { vault: { id: vault.id }, type: ClaimType.LP },
        });

        if (!lpClaimExists) {
          await this.claimRepository.save({
            vault: { id: vault.id },
            type: ClaimType.LP,
            amount: adjustedVtLpAmount,
            status: ClaimStatus.AVAILABLE,
            metadata: { adaAmount: Math.floor(lpAdaAmount * 1_000_000) },
          });

          this.logger.log(`Created LP claim: ${adjustedVtLpAmount} VT tokens, ${lpAdaAmount} ADA`);
        }
      } else {
        this.logger.log(`No LP claim created (LP % = ${vault.liquidity_pool_contribution}%)`);
      }

      // Get contribution transactions
      const contributionTransactions = await this.transactionsRepository.find({
        where: {
          vault_id: vault.id,
          type: TransactionType.contribute,
          status: TransactionStatus.confirmed,
        },
        relations: ['user'],
        order: { created_at: 'ASC' },
      });

      if (contributionTransactions.length === 0) {
        this.logger.warn(`Vault ${vault.id} has no confirmed contribution transactions. Marking as failed.`);

        const response = await this.vaultManagingService.updateVaultMetadataTx({
          vault,
          vaultStatus: SmartContractVaultStatus.CANCELLED,
        });

        await this.executePhaseTransition({
          vaultId: vault.id,
          newStatus: VaultStatus.failed,
          newScStatus: SmartContractVaultStatus.CANCELLED,
          txHash: response.txHash,
        });

        return;
      }

      // Calculate value of each contribution transaction
      const contributionValueByTransaction: Record<string, number> = {};
      const userContributedValueMap: Record<string, number> = {};

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
          try {
            const { priceAda } = await this.taptoolsService.getAssetValue(asset.policy_id, asset.asset_id);
            const quantity = asset.quantity || 1;
            transactionValueAda += priceAda * quantity;
          } catch (error) {
            this.logger.error(`Error getting price for asset ${asset.policy_id}.${asset.asset_id}:`, error.message);
          }
        }

        // Store value of this transaction
        contributionValueByTransaction[tx.id] = transactionValueAda;

        // Track total per user
        if (!userContributedValueMap[tx.user.id]) {
          userContributedValueMap[tx.user.id] = 0;
        }
        userContributedValueMap[tx.user.id] += transactionValueAda;
      }

      // Create contributor claims (VT tokens only, no ADA)
      const contributorClaims: Partial<Claim>[] = [];

      for (const tx of contributionTransactions) {
        if (!tx.user || !tx.user.id) continue;

        const userId = tx.user.id;
        const txValueAda = contributionValueByTransaction[tx.id] || 0;

        // Skip transactions with zero value
        if (txValueAda <= 0) {
          this.logger.warn(`Skipping contribution transaction ${tx.id} with zero value`);
          continue;
        }

        try {
          // Check if claim already exists
          const claimExists = await this.claimRepository.exists({
            where: {
              transaction: { id: tx.id },
              type: ClaimType.CONTRIBUTOR,
            },
          });

          if (claimExists) {
            this.logger.log(`Claim already exists for contributor transaction ${tx.id}`);
            continue;
          }

          const userTotalValue = userContributedValueMap[userId] || 0;

          // Calculate contributor tokens (no ADA, only VT)
          const contributorResult = this.distributionCalculationService.calculateContributorTokens({
            txContributedValue: txValueAda,
            userTotalValue,
            totalAcquiredAda: 0, // No acquirers
            totalTvl: totalContributedValueAda,
            lpAdaAmount,
            lpVtAmount,
            vtSupply,
            ASSETS_OFFERED_PERCENT: 0, // 0% for acquirers = 100% for contributors
          });

          // Create claim with VT tokens only (no ADA distribution)
          const claim = this.claimRepository.create({
            user: { id: userId },
            vault: { id: vault.id },
            type: ClaimType.CONTRIBUTOR,
            amount: contributorResult.vtAmount,
            status: ClaimStatus.PENDING,
            transaction: { id: tx.id },
            metadata: {
              adaAmount: 0, // No ADA distribution (no acquirers)
              vtPrice,
              contributedValueAda: txValueAda,
              userTotalValueAda: userTotalValue,
              proportionOfUserTotal: contributorResult.proportionOfUserTotal,
              userTotalVtTokens: contributorResult.userTotalVtTokens,
              noAcquirers: true, // Flag for clarity
            },
          });

          contributorClaims.push(claim);

          this.logger.log(
            `Created contributor claim for user ${userId}: ` +
              `${contributorResult.vtAmount} VT tokens (no ADA) for transaction ${tx.id}`
          );
        } catch (error) {
          this.logger.error(`Failed to create contributor claim for user ${userId} transaction ${tx.id}:`, error);
        }
      }

      // Save all contributor claims
      if (contributorClaims.length > 0) {
        try {
          await this.claimRepository.save(contributorClaims);
          this.logger.log(`Saved ${contributorClaims.length} contributor claims for vault ${vault.id}`);
        } catch (error) {
          this.logger.error(`Failed to save batch of contributor claims for vault ${vault.id}:`, error);
          throw error;
        }
      } else {
        this.logger.warn(
          `No contributor claims created for vault ${vault.id}. ` +
            `This may indicate an issue with contribution value calculations.`
        );
      }

      // Get final claims for multiplier calculation
      const finalContributorClaims = await this.claimRepository.find({
        where: {
          vault: { id: vault.id },
          type: ClaimType.CONTRIBUTOR,
        },
        relations: ['transaction', 'transaction.assets'],
        order: { created_at: 'ASC' },
      });

      // Calculate acquire multipliers (only contributors, no acquirers)
      const { acquireMultiplier } = this.distributionCalculationService.calculateAcquireMultipliers({
        contributorsClaims: finalContributorClaims,
        acquirerClaims: [], // No acquirers
      });

      this.logger.log(
        `Calculated acquire multipliers for ${finalContributorClaims.length} contributors ` + `(no acquirers)`
      );

      // Update vault metadata and transition to governance
      const response = await this.vaultManagingService.updateVaultMetadataTx({
        vault,
        acquireMultiplier,
        adaDistribution: [], // No ADA distribution (no acquirers)
        adaPairMultiplier,
        vaultStatus: SmartContractVaultStatus.SUCCESSFUL,
      });

      if (!response.txHash) {
        this.logger.error(`Failed to get txHash for vault ${vault.id} metadata update transaction`);
        throw new Error('Failed to update vault metadata');
      }

      // Transition to governance phase
      await this.executePhaseTransition({
        vaultId: vault.id,
        newStatus: VaultStatus.locked,
        phaseStartField: 'governance_phase_start',
        newScStatus: SmartContractVaultStatus.SUCCESSFUL,
        txHash: response.txHash,
        acquire_multiplier: acquireMultiplier,
        ada_pair_multiplier: adaPairMultiplier,
        vtPrice,
        fdv,
        fdvTvl: 1, // FDV = TVL when no acquirers
      });

      this.logger.log(
        `Successfully transitioned vault ${vault.id} directly to governance ` +
          `(0% acquirers). FDV: ${fdv} ADA, VT Price: ${vtPrice} ADA`
      );

      // Emit events
      try {
        this.eventEmitter.emit('distribution.claim_available', {
          vaultId: vault.id,
          vaultName: vault.name,
          tokenHolderIds: [...new Set(finalContributorClaims.map(c => c.user_id))],
        });

        this.eventEmitter.emit('vault.success', {
          vaultId: vault.id,
          vaultName: vault.name,
          tokenHoldersIds: [...new Set(finalContributorClaims.map(c => c.user_id))],
          adaSpent: 0, // No acquirers
          tokenPercentage: 0, // 0% for acquirers
          tokenTicker: vault.vault_token_ticker,
          impliedVaultValue: totalContributedValueAda, // FDV = TVL
        });
      } catch (error) {
        this.logger.error(`Error emitting events for vault ${vault.id}:`, error);
      }
    } catch (error) {
      this.logger.error(`Error in direct contribution to governance for vault ${vault.id}:`, error);
      throw error;
    }
  }
}
