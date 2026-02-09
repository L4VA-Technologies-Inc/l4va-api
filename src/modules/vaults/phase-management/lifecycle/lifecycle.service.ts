import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { ClaimsService } from '../../claims/claims.service';
import { TransactionsService } from '../../processing-tx/offchain-tx/transactions.service';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { TokenRegistry } from '@/database/tokenRegistry.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { DistributionCalculationService } from '@/modules/distribution/distribution-calculation.service';
import { MultiBatchDistributionService } from '@/modules/distribution/multi-batch-distribution.service';
import { SystemSettingsService } from '@/modules/globals/system-settings/system-settings.service';
import { TaptoolsService } from '@/modules/taptools/taptools.service';
import { MetadataRegistryApiService } from '@/modules/vaults/processing-tx/onchain/metadata-register.service';
import { VaultManagingService } from '@/modules/vaults/processing-tx/onchain/vault-managing.service';
import { TreasuryWalletService } from '@/modules/vaults/treasure/treasure-wallet.service';
import { AssetOriginType, AssetType } from '@/types/asset.types';
import { ClaimStatus, ClaimType } from '@/types/claim.types';
import { TokenRegistryStatus } from '@/types/tokenRegistry.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';
import {
  VaultStatus,
  ContributionWindowType,
  InvestmentWindowType,
  SmartContractVaultStatus,
  VaultFailureReason,
} from '@/types/vault.types';

@Injectable()
export class LifecycleService {
  private readonly logger = new Logger(LifecycleService.name);
  private readonly processingVaults = new Set<string>(); // Track vaults currently being processed
  private readonly MAX_FAILED_ATTEMPTS = 3; // Maximum allowed failed attempts before skipping

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
    private readonly vaultManagingService: VaultManagingService,
    private readonly distributionCalculationService: DistributionCalculationService,
    private readonly multiBatchDistributionService: MultiBatchDistributionService,
    private readonly taptoolsService: TaptoolsService,
    private readonly metadataRegistryApiService: MetadataRegistryApiService,
    private readonly treasuryWalletService: TreasuryWalletService,
    private readonly claimsService: ClaimsService,
    private readonly transactionsService: TransactionsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly systemSettingsService: SystemSettingsService
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
    acquire_multiplier?: [string, string | null, number][];
    ada_distribution?: [string, string | null, number][];
    ada_pair_multiplier?: number;
    vtPrice?: number;
    fdv?: number;
    fdvTvl?: number;
    failureReason?: VaultFailureReason;
    failureDetails?: any;
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
        vault[data.phaseStartField] = new Date();
      }

      if (data.newStatus === VaultStatus.failed) {
        vault.failure_reason = data.failureReason;
        vault.failure_details = data.failureDetails;

        const pr = await this.tokenRegistryRepository.findOne({
          where: {
            vault_id: data.vaultId,
            status: TokenRegistryStatus.PENDING,
          },
          select: ['id', 'pr_number'],
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

        try {
          await this.treasuryWalletService.createTreasuryWallet({
            vaultId: vault.id,
          });
        } catch (error) {
          this.logger.error(`Failed to create treasury wallet for vault ${vault.id}:`, error);
        }
      }

      if (data.newScStatus === SmartContractVaultStatus.SUCCESSFUL) {
        vault.vault_sc_status = data.newScStatus;
        vault.last_update_tx_hash = data.txHash;
        vault.locked_at = new Date();
        vault.ada_pair_multiplier = data.ada_pair_multiplier;
        vault.vt_price = data.vtPrice;
        vault.acquire_multiplier = data.acquire_multiplier;
        vault.ada_distribution = data.ada_distribution;
        vault.fdv = data.fdv;
        vault.fdv_tvl = data.fdvTvl;

        // Set initial value for gains calculation (baseline for future price changes)
        // This is the total value of all contributed assets at the moment of locking
        if (vault.total_assets_cost_ada && vault.total_assets_cost_ada > 0) {
          vault.initial_total_value_ada = vault.total_assets_cost_ada;
        }
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

  private async handlePublishedToContribution(): Promise<void> {
    // Handle immediate start vaults
    const immediateStartVaults = await this.vaultRepository
      .createQueryBuilder('vault')
      .leftJoin('transactions', 'tx', 'tx.vault_id = vault.id')
      .where('vault.vault_status = :status', { status: VaultStatus.published })
      .andWhere('vault.contract_address IS NOT NULL')
      .andWhere('vault.contribution_open_window_type = :type', { type: ContributionWindowType.uponVaultLaunch })
      .andWhere('tx.type = :txType', { txType: TransactionType.createVault })
      .andWhere('tx.status = :txStatus', { txStatus: TransactionStatus.confirmed })
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
      .leftJoin('transactions', 'tx', 'tx.vault_id = vault.id')
      .where('vault.vault_status = :status', { status: VaultStatus.published })
      .andWhere('vault.contribution_open_window_type = :type', { type: ContributionWindowType.custom })
      .andWhere('vault.contribution_open_window_time IS NOT NULL')
      .andWhere('vault.contract_address IS NOT NULL')
      .andWhere('tx.type = :txType', { txType: TransactionType.createVault })
      .andWhere('tx.status = :txStatus', { txStatus: TransactionStatus.confirmed })
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
   * - Scenario 1: Vault has assets, policy has 1 asset, min=1, max=5 → ✅ PASS (soft requirement, within max)
   * - Scenario 2: Vault has assets, some specific policy has 0 assets, min=1, max=5 → ✅ PASS (soft requirement ignores min)
   * - Scenario 3: Vault has assets, policy has 1 asset, min=2, max=5 → ❌ FAIL (below required minimum)
   * - Scenario 4: Vault has no assets, any policy → ❌ FAIL (no contributions)
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
      .leftJoinAndSelect('vault.assets_whitelist', 'assets_whitelist')
      .leftJoinAndSelect('vault.assets', 'assets', 'assets.deleted = :deleted', { deleted: false })
      .getMany();

    for (const vault of contributionVaults) {
      // Check for failed update-vault transactions
      const failedTransactionsCount = await this.transactionsRepository.count({
        where: {
          vault_id: vault.id,
          type: TransactionType.updateVault,
          status: TransactionStatus.failed,
        },
      });

      if (failedTransactionsCount >= this.MAX_FAILED_ATTEMPTS) {
        this.logger.warn(
          `Skipping vault ${vault.id} - exceeded max failed attempts (${failedTransactionsCount}/${this.MAX_FAILED_ATTEMPTS}) for update-vault transactions`
        );
        continue;
      }

      await this.transactionsService.syncVaultTransactions(vault.id);

      // Check if vault has any contributed assets (excluding fee-type assets)
      const contributedAssets = vault.assets.filter(asset => asset.origin_type === AssetOriginType.CONTRIBUTED);

      if (contributedAssets.length === 0) {
        this.logger.warn(`Vault ${vault.id} has no contributed assets. Failing vault.`);

        const response = await this.vaultManagingService.updateVaultMetadataTx({
          vault,
          vaultStatus: SmartContractVaultStatus.CANCELLED,
        });
        await this.claimsService.createCancellationClaims(vault, 'no_contributions');
        await this.executePhaseTransition({
          vaultId: vault.id,
          newStatus: VaultStatus.failed,
          newScStatus: SmartContractVaultStatus.CANCELLED,
          txHash: response.txHash,
          failureReason: VaultFailureReason.NO_CONTRIBUTIONS,
          failureDetails: {
            message: 'No assets were contributed to the vault',
            totalAssets: vault.assets.length,
            contributedAssets: 0,
          },
        });

        continue;
      }

      const policyIdCounts = contributedAssets.reduce(
        (counts, asset) => {
          if (!counts[asset.policy_id]) {
            counts[asset.policy_id] = 0;
          }
          // Ensure numeric addition by converting quantity to number
          const quantity = Number(asset.quantity) || 1;
          counts[asset.policy_id] += quantity;
          return counts;
        },
        {} as Record<string, number>
      );

      let assetsWithinThreshold = true;
      const thresholdViolations: Array<{ policyId: string; count: number; min: number; max: number }> = [];

      // Check if vault has at least one contributed asset (already validated above)
      const hasAnyAssets = contributedAssets.length > 0;

      if (vault.assets_whitelist && vault.assets_whitelist.length > 0) {
        for (const whitelistItem of vault.assets_whitelist) {
          const policyId = whitelistItem.policy_id;
          const count = Number(policyIdCounts[policyId]) || 0;
          const minRequired = Number(whitelistItem.asset_count_cap_min);
          const maxAllowed = Number(whitelistItem.asset_count_cap_max);

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

          // Check for failed transactions before attempting cancellation update
          if (failedTransactionsCount >= this.MAX_FAILED_ATTEMPTS) {
            this.logger.warn(
              `Skipping vault ${vault.id} cancellation update - exceeded max failed attempts (${failedTransactionsCount}/${this.MAX_FAILED_ATTEMPTS}) for update-vault transactions`
            );
            continue;
          }

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
            failureReason: VaultFailureReason.ASSET_THRESHOLD_VIOLATION,
            failureDetails: {
              message: 'Assets do not meet threshold requirements',
              thresholdViolations,
            },
          });

          continue;
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

  /**
   * Check for vaults in Acquire phase that have reached their deadline
   * Triggers transition to Governance phase (or failure if threshold not met)
   * Skips vaults with too many failed update-vault transaction attempts
   */
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

    // I want to get all failed transaction for vault with type update-vault. If there is more than MAX_FAILED_ATTEMPTS. I will skip the vault processing

    for (const vault of acquireVaults) {
      const failedTransactionsCount = await this.transactionsRepository.count({
        where: {
          vault_id: vault.id,
          type: TransactionType.updateVault,
          status: TransactionStatus.failed,
        },
      });

      if (failedTransactionsCount >= this.MAX_FAILED_ATTEMPTS) {
        this.logger.warn(
          `Skipping vault ${vault.id} - exceeded max failed attempts (${failedTransactionsCount}/${this.MAX_FAILED_ATTEMPTS}) for update-vault transactions`
        );
        continue;
      }
      try {
        this.processingVaults.add(vault.id);
        await this.executeAcquireToGovernanceTransition(vault);
      } finally {
        this.processingVaults.delete(vault.id);
      }
    }
  }

  /**
   * Handle transition from Acquire phase to Governance phase
   * Triggered when acquire phase ends - calculates token distribution and creates claims
   *
   * Flow:
   * 1. Sync and fetch all acquire & contribute transactions
   * 2. Calculate total ADA acquired and total value of contributed assets
   * 3. Check if acquire threshold is met (totalAcquiredAda >= requiredThresholdAda)
   *
   * If threshold met (Success):
   * - Calculate LP tokens (VT + ADA) based on LP percentage
   * - Create LP claim if liquidity meets minimum threshold
   * - Calculate and create acquirer claims (VT tokens based on ADA sent)
   * - Calculate and create contributor claims (VT tokens + ADA based on asset value)
   * - Calculate multipliers and ADA distribution ratios
   * - Update vault metadata on-chain with status SUCCESSFUL
   * - Transition vault to 'locked' status (governance phase)
   * - Emit success events for notifications
   *
   * If threshold not met (Failure):
   * - Update vault metadata on-chain with status CANCELLED
   * - Create cancellation claims for refunds
   * - Transition vault to 'failed' status
   * - Emit failure events for notifications
   *
   * Pricing:
   * - FT assets: Uses TapTools API (being replaced with DexHunter)
   * - NFT assets: Uses TapTools API (being replaced with WayUp Marketplace)
   * - Fallback to hardcoded prices if API fails
   */
  private async executeAcquireToGovernanceTransition(vault: Vault): Promise<void> {
    try {
      // Sync transactions one more time
      await this.transactionsService.syncVaultTransactions(vault.id);

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
            const isNFT = asset.type === AssetType.NFT;
            const { priceAda } = await this.taptoolsService.getAssetValue(asset.policy_id, asset.asset_id, isNFT);
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

        // Check if LP is configured and validate minimum threshold
        const lpAdaInLovelace = Math.floor(lpAdaAmount * 1_000_000);
        const minLpLiquidity = this.systemSettingsService.lpRecommendedMinLiquidity;
        const hasLpConfigured = vault.liquidity_pool_contribution > 0;

        if (hasLpConfigured && lpAdaInLovelace < minLpLiquidity) {
          // Vault has LP configured but doesn't meet minimum threshold - FAIL the vault
          this.logger.error(
            `Vault ${vault.id} FAILED: LP configured but insufficient liquidity. ` +
              `LP ADA: ${lpAdaAmount} ADA (${lpAdaInLovelace} lovelace) is below ` +
              `required minimum ${minLpLiquidity / 1_000_000} ADA (${minLpLiquidity} lovelace). ` +
              `Vault will transition to FAILED status and users will be refunded.`
          );

          // Transition vault to failed status
          const cancellationResponse = await this.vaultManagingService.updateVaultMetadataTx({
            vault,
            acquireMultiplier: [],
            adaDistribution: [],
            adaPairMultiplier: 0,
            vaultStatus: SmartContractVaultStatus.CANCELLED,
          });

          if (!cancellationResponse.txHash) {
            this.logger.error(`Failed to get txHash for vault ${vault.id} cancellation transaction`);
            return;
          }

          await this.claimsService.createCancellationClaims(vault, 'insufficient_lp_liquidity');

          await this.executePhaseTransition({
            vaultId: vault.id,
            newStatus: VaultStatus.failed,
            txHash: cancellationResponse.txHash,
            failureReason: VaultFailureReason.INSUFFICIENT_LP_LIQUIDITY,
            failureDetails: {
              lpAdaAmount,
              lpAdaInLovelace,
              minLpLiquidity,
              minLpLiquidityAda: minLpLiquidity / 1_000_000,
              message: `LP liquidity ${lpAdaAmount} ADA is below required minimum ${minLpLiquidity / 1_000_000} ADA`,
            },
          });

          this.eventEmitter.emit('vault.failed', {
            vaultId: vault.id,
            vaultName: vault.name,
            reason: VaultFailureReason.INSUFFICIENT_LP_LIQUIDITY,
            lpAdaAmount,
            minLpLiquidityAda: minLpLiquidity / 1_000_000,
          });

          return;
        }

        try {
          if (adjustedVtLpAmount > 0 && lpAdaAmount > 0) {
            // LP meets minimum threshold or LP is not configured - create LP claim
            if (lpAdaInLovelace < minLpLiquidity) {
              this.logger.log(
                `No LP claim created for vault ${vault.id}: ` +
                  `LP percentage is 0% or LP liquidity ${lpAdaAmount} ADA is below recommended minimum.`
              );
            } else {
              const lpClaimExists = await this.claimRepository.exists({
                where: { vault: { id: vault.id }, type: ClaimType.LP },
              });

              if (!lpClaimExists) {
                await this.claimRepository.save({
                  vault: { id: vault.id },
                  type: ClaimType.LP,
                  amount: adjustedVtLpAmount,
                  status: ClaimStatus.AVAILABLE,
                  lovelace_amount: lpAdaInLovelace,
                });

                this.logger.log(`Created LP claim: ${adjustedVtLpAmount} VT tokens, ${lpAdaAmount} ADA`);
              }
            }
          } else {
            this.logger.log(
              `No LP claim created (LP % = ${vault.liquidity_pool_contribution}%, ` +
                `LP VT: ${adjustedVtLpAmount}, LP ADA: ${lpAdaAmount})`
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
              multiplier: multiplier,
            });
            acquirerClaims.push(claim);
          } catch (error) {
            this.logger.error(`Failed to create acquirer claim for user ${userId} transaction ${tx.id}:`, error);
          }
        }

        if (acquirerClaims.length > 0) {
          try {
            const minMultiplier = Math.min(...acquirerClaims.map(c => c.multiplier));

            for (const claim of acquirerClaims) {
              const transaction = acquisitionTransactions.find(tx => tx.id === claim.transaction.id);
              claim.amount = minMultiplier * transaction.amount * 1_000_000;
              claim.multiplier = minMultiplier;
            }

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
              lovelace_amount: contributorResult.lovelaceAmount,
            });

            contributorClaims.push(claim);
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

        const { acquireMultiplier, adaDistribution, recalculatedClaimAmounts, recalculatedLovelaceAmounts } =
          this.distributionCalculationService.calculateAcquireMultipliers({
            contributorsClaims: finalContributorClaims,
            acquirerClaims: finalAcquirerClaims,
          });

        // Update contributor claim amounts to match smart contract calculation (qty × multiplier)
        // This ensures the transaction validation will pass
        if (recalculatedClaimAmounts.size > 0 || recalculatedLovelaceAmounts.size > 0) {
          const claimsToUpdate = [];
          for (const claim of finalContributorClaims) {
            const recalculatedVt = recalculatedClaimAmounts.get(claim.id);
            const recalculatedLovelace = recalculatedLovelaceAmounts.get(claim.id);
            const vtNeedsUpdate = recalculatedVt !== undefined && recalculatedVt !== claim.amount;
            const lovelaceNeedsUpdate =
              recalculatedLovelace !== undefined && recalculatedLovelace !== claim.lovelace_amount;

            if (vtNeedsUpdate || lovelaceNeedsUpdate) {
              if (vtNeedsUpdate) {
                this.logger.debug(
                  `Updating claim ${claim.id} VT amount from ${claim.amount} to ${recalculatedVt} (diff: ${claim.amount - recalculatedVt})`
                );
                claim.amount = recalculatedVt;
              }
              if (lovelaceNeedsUpdate) {
                this.logger.debug(
                  `Updating claim ${claim.id} lovelace from ${claim.lovelace_amount} to ${recalculatedLovelace} (diff: ${claim.lovelace_amount - recalculatedLovelace})`
                );
                claim.lovelace_amount = recalculatedLovelace;
              }
              claimsToUpdate.push(claim);
            }
          }
          if (claimsToUpdate.length > 0) {
            await this.claimRepository.save(claimsToUpdate);
            this.logger.log(
              `Updated ${claimsToUpdate.length} contributor claim amounts to match multiplier calculation`
            );
          }
        }

        // Recalculate optimal decimals now that we have final multiplier values
        // This ensures we don't hit floating point precision issues
        const maxMultiplier = Math.max(...acquireMultiplier.map(m => m[2]), 0);
        const minMultiplier = Math.min(...acquireMultiplier.map(m => m[2]).filter(m => m > 0), Infinity);
        const maxAdaDistribution = Math.max(...adaDistribution.map(d => d[2]), 0);
        const minAdaDistribution = Math.min(...adaDistribution.map(d => d[2]).filter(d => d > 0), Infinity);
        const maxValue = Math.max(maxMultiplier, maxAdaDistribution);
        const minValue = Math.min(
          minMultiplier === Infinity ? 1 : minMultiplier,
          minAdaDistribution === Infinity ? 1 : minAdaDistribution
        );

        this.logger.log(
          `Vault ${vault.id} multiplier stats: ` +
            `maxMultiplier=${maxMultiplier}, minMultiplier=${minMultiplier === Infinity ? 'N/A' : minMultiplier}, ` +
            `maxAdaDist=${maxAdaDistribution}, minAdaDist=${minAdaDistribution === Infinity ? 'N/A' : minAdaDistribution}`
        );

        const optimalDecimals = this.distributionCalculationService.calculateOptimalDecimals(
          vault.ft_token_supply || 1_000_000,
          maxValue,
          minValue
        );

        // Update vault decimals if they changed
        if (optimalDecimals !== vault.ft_token_decimals) {
          this.logger.log(
            `Updating vault ${vault.id} decimals from ${vault.ft_token_decimals} to ${optimalDecimals} ` +
              `(maxMultiplier: ${maxMultiplier}, maxAdaDistribution: ${maxAdaDistribution})`
          );
          vault.ft_token_decimals = optimalDecimals;
          await this.vaultRepository.update(vault.id, { ft_token_decimals: optimalDecimals });
        }

        // Check if multipliers need to be split across multiple transactions
        const batchingStrategy = await this.multiBatchDistributionService.calculateBatchingStrategy(
          vault,
          acquireMultiplier,
          adaDistribution,
          adaPairMultiplier
        );

        let response;
        let finalAcquireMultiplier = acquireMultiplier;
        let finalAdaDistribution = adaDistribution;

        if (!batchingStrategy.needsBatching) {
          // All multipliers fit in single transaction - proceed normally
          response = await this.vaultManagingService.updateVaultMetadataTx({
            vault,
            acquireMultiplier,
            adaDistribution,
            adaPairMultiplier,
            vaultStatus: SmartContractVaultStatus.SUCCESSFUL,
          });
        } else {
          // Multi-batch distribution required
          this.logger.log(
            `Vault ${vault.id}: Initiating multi-batch distribution. ` +
              `Total batches: ${batchingStrategy.totalBatches}`
          );

          // Update vault with first batch of multipliers
          response = await this.vaultManagingService.updateVaultMetadataTx({
            vault,
            acquireMultiplier: batchingStrategy.firstBatchMultipliers,
            adaDistribution: batchingStrategy.firstBatchAdaDistribution,
            adaPairMultiplier,
            vaultStatus: SmartContractVaultStatus.SUCCESSFUL,
          });

          // Store batching state in vault
          await this.multiBatchDistributionService.updateVaultBatchProgress(vault.id, {
            currentBatch: 1,
            totalBatches: batchingStrategy.totalBatches,
            pendingMultipliers: batchingStrategy.pendingMultipliers,
            pendingAdaDistribution: batchingStrategy.pendingAdaDistribution,
            acquireMultiplier: batchingStrategy.firstBatchMultipliers,
            adaDistribution: batchingStrategy.firstBatchAdaDistribution,
          });

          // Assign claims to first batch based on included multipliers
          await this.multiBatchDistributionService.assignClaimsToBatch(
            vault.id,
            batchingStrategy.firstBatchMultipliers,
            1
          );

          // Update the final values for phase transition
          finalAcquireMultiplier = batchingStrategy.firstBatchMultipliers;
          finalAdaDistribution = batchingStrategy.firstBatchAdaDistribution;

          this.logger.log(
            `Vault ${vault.id}: First batch submitted. ` +
              `Multipliers: ${batchingStrategy.firstBatchMultipliers.length}/${acquireMultiplier.length}, ` +
              `Pending: ${batchingStrategy.pendingMultipliers.length}`
          );
        }

        if (!response.txHash) {
          this.logger.error(`Failed to get txHash for vault ${vault.id} metadata update transaction`);
          return;
        }

        try {
          await this.taptoolsService.updateAssetPrices([vault.id]);
          // Recalculate vault totals with fresh prices
          await this.taptoolsService.updateMultipleVaultTotals([vault.id]);
        } catch (error) {
          this.logger.error(`Failed to update prices before locking vault ${vault.id}:`, error);
        }

        // Submit token metadata PR now that decimals are finalized
        try {
          this.logger.log(
            `Submitting token metadata PR for vault ${vault.id} with finalized decimals: ${optimalDecimals}`
          );
          await this.metadataRegistryApiService.submitVaultTokenMetadata(vault.id);
        } catch (metadataError) {
          this.logger.error(
            `Failed to submit token metadata for vault ${vault.id}: ${metadataError.message}`,
            metadataError.stack
          );
          // Don't fail the transition - PR submission is non-critical
        }

        await this.executePhaseTransition({
          vaultId: vault.id,
          newStatus: VaultStatus.locked,
          phaseStartField: 'governance_phase_start',
          newScStatus: SmartContractVaultStatus.SUCCESSFUL,
          txHash: response.txHash,
          acquire_multiplier: finalAcquireMultiplier,
          ada_distribution: finalAdaDistribution,
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
          failureReason: VaultFailureReason.ACQUIRE_THRESHOLD_NOT_MET,
          failureDetails: {
            message: 'Required acquisition threshold not met',
            requiredAda: requiredThresholdAda,
            actualAda: totalAcquiredAda,
          },
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
   * TEST METHOD: Simulate multiplier calculations for a vault without executing the transition
   * This is useful for testing and validation of multiplier calculations
   * @param vaultId - The vault ID to simulate calculations for
   * @returns Simulated multiplier data and asset pricing information
   */
  async simulateVaultMultipliers(vaultId: string): Promise<{
    vault: {
      id: string;
      name: string;
      status: VaultStatus;
      totalAssets: number;
    };
    calculations: {
      totalAcquiredAda: number;
      totalContributedValueAda: number;
      requiredThresholdAda: number;
      meetsThreshold: boolean;
      vtSupply: number;
      assetsOfferedPercent: number;
      lpPercent: number;
    };
    lpTokens: {
      lpAdaAmount: number;
      lpVtAmount: number;
      vtPrice: number;
      fdv: number;
      adjustedVtLpAmount: number;
      adaPairMultiplier: number;
    };
    multipliers: {
      acquireMultiplier: [string, string, number][];
      adaDistribution: [string, string, number][];
      maxMultiplier: number;
      minMultiplier: number;
      maxAdaDistribution: number;
      minAdaDistribution: number;
    };
    groupingDetails: {
      vtMultiplierGroups: {
        policyId: string;
        policyName?: string;
        multiplier: number;
        maxMultiplier: number;
        multiplierVariance: number;
        assetCount: number;
        isGrouped: boolean;
        groupingReason: string;
        assets: Array<{
          assetName: string;
          quantity: number;
          multiplier: number;
        }>;
      }[];
      adaDistributionGroups: {
        policyId: string;
        policyName?: string;
        adaMultiplier: number;
        maxAdaMultiplier: number;
        multiplierVariance: number;
        assetCount: number;
        isGrouped: boolean;
        groupingReason: string;
        assets: Array<{
          assetName: string;
          quantity: number;
          adaMultiplier: number;
        }>;
      }[];
      stats: {
        totalVtGroups: number;
        vtGroupedPolicies: number;
        vtUngroupedAssets: number;
        vtOriginalAssetCount: number;
        vtCompressionRatio: number;
        totalAdaGroups: number;
        adaGroupedPolicies: number;
        adaUngroupedAssets: number;
        adaOriginalAssetCount: number;
        adaCompressionRatio: number;
        mixedValuePolicies: Array<{
          policyId: string;
          vtMultipliers: number[];
          adaMultipliers: number[];
        }>;
      };
    };
    assetPricing: {
      policyId: string;
      assetName: string;
      priceAda: number;
      quantity: number;
      totalValueAda: number;
      isNFT: boolean;
    }[];
    decimals: {
      current: number;
      optimal: number;
      needsUpdate: boolean;
    };
    transactionSize: {
      txSizeBytes: number;
      txSizeKB: number;
      maxSizeBytes: number;
      percentOfMax: number;
      withinLimit: boolean;
      multiplierCount: number;
      adaDistributionCount: number;
      estimatedFee?: number;
      warning?: string;
    };
  }> {
    this.logger.log(`Simulating multiplier calculations for vault ${vaultId}`);

    // Fetch vault with all necessary relations
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      relations: ['owner', 'assets'],
    });

    if (!vault) {
      throw new Error(`Vault ${vaultId} not found`);
    }

    // Sync transactions
    // await this.transactionsService.syncVaultTransactions(vault.id);

    // Get all relevant transactions
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

    this.logger.log(
      `Found ${allTransactions.length} total transactions: ${acquisitionTransactions.length} acquire, ${contributionTransactions.length} contribute`
    );

    // Calculate total ADA from acquisitions
    let totalAcquiredAda = 0;
    for (const tx of acquisitionTransactions) {
      totalAcquiredAda += tx.amount || 0;
    }

    // Calculate total value of contributed assets
    let totalContributedValueAda = 0;
    const assetPricing: {
      policyId: string;
      assetName: string;
      priceAda: number;
      quantity: number;
      totalValueAda: number;
      isNFT: boolean;
    }[] = [];

    for (const tx of contributionTransactions) {
      if (!tx.user_id) {
        this.logger.warn(`Skipping transaction ${tx.id} - no user_id`);
        continue;
      }

      const txAssets = await this.assetsRepository.find({
        where: {
          transaction: { id: tx.id },
          origin_type: AssetOriginType.CONTRIBUTED,
          deleted: false,
        },
      });

      for (const asset of txAssets) {
        try {
          const isNFT = asset.type === AssetType.NFT;
          // Use floor_price from entity first, fallback to dex_price, then 0
          const priceAda = asset.floor_price || asset.dex_price || 0;

          const quantity = asset.quantity || 1;
          const totalValueAda = priceAda * quantity;

          totalContributedValueAda += totalValueAda;

          assetPricing.push({
            policyId: asset.policy_id,
            assetName: asset.asset_id,
            priceAda,
            quantity,
            totalValueAda,
            isNFT,
          });
        } catch (error) {
          this.logger.error(`Error processing asset ${asset.policy_id}.${asset.asset_id}:`, error.message);
        }
      }
    }

    const vtSupply = vault.ft_token_supply * 10 ** vault.ft_token_decimals || 0;
    const ASSETS_OFFERED_PERCENT = vault.tokens_for_acquires * 0.01;
    const LP_PERCENT = vault.liquidity_pool_contribution * 0.01;

    const requiredThresholdAda =
      totalContributedValueAda * vault.tokens_for_acquires * 0.01 * vault.acquire_reserve * 0.01;
    const meetsThreshold = totalAcquiredAda >= requiredThresholdAda;

    // Calculate LP tokens
    const lpResult = this.distributionCalculationService.calculateLpTokens({
      vtSupply,
      totalAcquiredAda,
      totalContributedValueAda,
      assetsOfferedPercent: ASSETS_OFFERED_PERCENT,
      lpPercent: LP_PERCENT,
    });

    // Simulate claim creation to calculate multipliers
    const mockContributorClaims: Partial<Claim>[] = [];
    const mockAcquirerClaims: Partial<Claim>[] = [];

    // Create mock acquirer claims
    for (const tx of acquisitionTransactions) {
      if (!tx.user || !tx.user.id) continue;
      const adaSent = tx.amount || 0;
      if (adaSent <= 0) continue;

      const { vtReceived, multiplier } = this.distributionCalculationService.calculateAcquirerTokens({
        adaSent,
        totalAcquiredValueAda: totalAcquiredAda,
        lpAdaAmount: lpResult.lpAdaAmount,
        lpVtAmount: lpResult.lpVtAmount,
        vtPrice: lpResult.vtPrice,
        vtSupply,
        ASSETS_OFFERED_PERCENT,
      });

      mockAcquirerClaims.push({
        id: tx.id,
        amount: vtReceived,
        multiplier: multiplier,
        transaction: tx as any,
      });
    }

    // Create mock contributor claims
    const contributionValueByTransaction: Record<string, number> = {};
    const userContributedValueMap: Record<string, number> = {};

    for (const tx of contributionTransactions) {
      if (!tx.user_id) continue;

      const txAssets = await this.assetsRepository.find({
        where: {
          transaction: { id: tx.id },
          origin_type: AssetOriginType.CONTRIBUTED,
          deleted: false,
        },
      });

      let transactionValueAda = 0;
      for (const asset of txAssets) {
        try {
          // Use floor_price from entity first, fallback to dex_price, then 0
          const priceAda = asset.floor_price || asset.dex_price || 0;
          const quantity = asset.quantity || 1;
          transactionValueAda += priceAda * quantity;
        } catch (error) {
          this.logger.error(`Error processing asset ${asset.policy_id}.${asset.asset_id}:`, error.message);
        }
      }

      contributionValueByTransaction[tx.id] = transactionValueAda;

      if (!userContributedValueMap[tx.user.id]) {
        userContributedValueMap[tx.user.id] = 0;
      }
      userContributedValueMap[tx.user.id] += transactionValueAda;

      const txValueAda = contributionValueByTransaction[tx.id] || 0;
      if (txValueAda <= 0) continue;

      const userTotalValue = userContributedValueMap[tx.user.id] || 0;

      const contributorResult = this.distributionCalculationService.calculateContributorTokens({
        txContributedValue: txValueAda,
        userTotalValue,
        totalAcquiredAda,
        totalTvl: totalContributedValueAda,
        lpAdaAmount: lpResult.lpAdaAmount,
        lpVtAmount: lpResult.lpVtAmount,
        vtSupply,
        ASSETS_OFFERED_PERCENT,
      });

      // Load assets for this transaction
      tx.assets = txAssets;

      mockContributorClaims.push({
        id: tx.id,
        amount: contributorResult.vtAmount,
        lovelace_amount: contributorResult.lovelaceAmount,
        transaction: tx as any,
      });
    }

    // Calculate multipliers using the distribution service
    const multiplierResult = this.distributionCalculationService.calculateAcquireMultipliers({
      contributorsClaims: mockContributorClaims as Claim[],
      acquirerClaims: mockAcquirerClaims as Claim[],
    });

    // Analyze grouping details
    const groupingDetails = this.analyzeMultiplierGrouping(
      multiplierResult.acquireMultiplier,
      multiplierResult.adaDistribution,
      mockContributorClaims as Claim[]
    );

    // Calculate stats
    const maxMultiplier = Math.max(...multiplierResult.acquireMultiplier.map(m => m[2]), 0);
    const minMultiplier = Math.min(...multiplierResult.acquireMultiplier.map(m => m[2]).filter(m => m > 0), Infinity);
    const maxAdaDistribution = Math.max(...multiplierResult.adaDistribution.map(d => d[2]), 0);
    const minAdaDistribution = Math.min(
      ...multiplierResult.adaDistribution.map(d => d[2]).filter(d => d > 0),
      Infinity
    );

    const maxValue = Math.max(maxMultiplier, maxAdaDistribution);
    const minValue = Math.min(
      minMultiplier === Infinity ? 1 : minMultiplier,
      minAdaDistribution === Infinity ? 1 : minAdaDistribution
    );

    const optimalDecimals = this.distributionCalculationService.calculateOptimalDecimals(
      vault.ft_token_supply || 1_000_000,
      maxValue,
      minValue
    );

    // Estimate transaction size for the update vault transaction
    let transactionSize: {
      txSizeBytes: number;
      txSizeKB: number;
      maxSizeBytes: number;
      percentOfMax: number;
      withinLimit: boolean;
      multiplierCount: number;
      adaDistributionCount: number;
      warning?: string;
    };

    try {
      const txSizeEstimate = await this.vaultManagingService.estimateUpdateVaultTxSize({
        vault: {
          id: vault.id,
          asset_vault_name: vault.asset_vault_name,
          privacy: vault.privacy,
          contribution_phase_start: vault.contribution_phase_start,
          contribution_duration: vault.contribution_duration,
          value_method: vault.value_method,
        },
        vaultStatus: SmartContractVaultStatus.SUCCESSFUL,
        acquireMultiplier: multiplierResult.acquireMultiplier,
      });

      transactionSize = {
        ...txSizeEstimate,
        warning: !txSizeEstimate.withinLimit
          ? `⚠️ Transaction size (${txSizeEstimate.txSizeKB} KB) exceeds Cardano limit (16 KB). Transaction will fail!`
          : txSizeEstimate.percentOfMax > 90
            ? `⚠️ Transaction size is ${txSizeEstimate.percentOfMax}% of max limit. Consider reducing assets.`
            : undefined,
      };

      this.logger.log(
        `Transaction size for vault ${vault.id}: ${txSizeEstimate.txSizeBytes} bytes ` +
          `(${txSizeEstimate.percentOfMax}% of max)`
      );
    } catch (error) {
      this.logger.error(`Failed to estimate transaction size for vault ${vault.id}:`, error);
      transactionSize = {
        txSizeBytes: 0,
        txSizeKB: 0,
        maxSizeBytes: 16384,
        percentOfMax: 0,
        withinLimit: false,
        multiplierCount: multiplierResult.acquireMultiplier.length,
        adaDistributionCount: multiplierResult.adaDistribution.length,
        warning: `❌ Failed to estimate transaction size: ${error.message}`,
      };
    }

    return {
      vault: {
        id: vault.id,
        name: vault.name,
        status: vault.vault_status,
        totalAssets: assetPricing.length,
      },
      calculations: {
        totalAcquiredAda,
        totalContributedValueAda,
        requiredThresholdAda,
        meetsThreshold,
        vtSupply,
        assetsOfferedPercent: ASSETS_OFFERED_PERCENT,
        lpPercent: LP_PERCENT,
      },
      lpTokens: {
        lpAdaAmount: lpResult.lpAdaAmount,
        lpVtAmount: lpResult.lpVtAmount,
        vtPrice: lpResult.vtPrice,
        fdv: lpResult.fdv,
        adjustedVtLpAmount: lpResult.adjustedVtLpAmount,
        adaPairMultiplier: lpResult.adaPairMultiplier,
      },
      multipliers: {
        acquireMultiplier: multiplierResult.acquireMultiplier,
        adaDistribution: multiplierResult.adaDistribution,
        maxMultiplier,
        minMultiplier: minMultiplier === Infinity ? 0 : minMultiplier,
        maxAdaDistribution,
        minAdaDistribution: minAdaDistribution === Infinity ? 0 : minAdaDistribution,
      },
      groupingDetails,
      assetPricing,
      decimals: {
        current: vault.ft_token_decimals,
        optimal: optimalDecimals,
        needsUpdate: optimalDecimals !== vault.ft_token_decimals,
      },
      transactionSize,
    };
  }

  /**
   * Analyze multiplier grouping to provide detailed insights
   * Now uses price-based grouping: assets with the same price within a policy are grouped together
   */
  private analyzeMultiplierGrouping(
    acquireMultiplier: [string, string | null, number][],
    adaDistribution: [string, string, number][],
    contributorClaims: Claim[]
  ): {
    vtMultiplierGroups: Array<{
      policyId: string;
      policyName?: string;
      multiplier: number;
      maxMultiplier: number;
      multiplierVariance: number;
      assetCount: number;
      isGrouped: boolean;
      groupingReason: string;
      assets: Array<{ assetName: string; quantity: number; multiplier: number }>;
    }>;
    adaDistributionGroups: Array<{
      policyId: string;
      policyName?: string;
      adaMultiplier: number;
      maxAdaMultiplier: number;
      multiplierVariance: number;
      assetCount: number;
      isGrouped: boolean;
      groupingReason: string;
      assets: Array<{ assetName: string; quantity: number; adaMultiplier: number }>;
    }>;
    stats: {
      totalVtGroups: number;
      vtGroupedPolicies: number;
      vtUngroupedAssets: number;
      vtOriginalAssetCount: number;
      vtCompressionRatio: number;
      totalAdaGroups: number;
      adaGroupedPolicies: number;
      adaUngroupedAssets: number;
      adaOriginalAssetCount: number;
      adaCompressionRatio: number;
      mixedValuePolicies: Array<{
        policyId: string;
        vtMultipliers: number[];
        adaMultipliers: number[];
      }>;
    };
  } {
    const GROUPING_THRESHOLD = 10;

    // Track assets by (policy, price) for price-based analysis
    interface AssetWithPrice {
      assetName: string;
      quantity: number;
      multiplier: number;
      adaMultiplier: number;
      price: number;
    }

    const assetsByPolicyAndPrice = new Map<string, AssetWithPrice[]>();

    // Collect all assets with their data and prices
    const allVtAssets = new Map<
      string,
      { policyId: string; assetName: string; quantity: number; multiplier: number; price: number }
    >();
    const allAdaAssets = new Map<
      string,
      { policyId: string; assetName: string; quantity: number; adaMultiplier: number; price: number }
    >();

    for (const claim of contributorClaims) {
      if (!claim.transaction?.assets) continue;

      const contributorLovelaceAmount = claim?.lovelace_amount || 0;
      const baseVtShare = Math.floor(claim.amount / claim.transaction.assets.length);
      const vtRemainder = claim.amount - baseVtShare * claim.transaction.assets.length;
      const baseAdaShare = Math.floor(contributorLovelaceAmount / claim.transaction.assets.length);
      const adaRemainder = contributorLovelaceAmount - baseAdaShare * claim.transaction.assets.length;

      claim.transaction.assets.forEach((asset, index) => {
        const vtShare = baseVtShare + (index < vtRemainder ? 1 : 0);
        const assetQuantity = Number(asset.quantity) || 1;
        const vtSharePerUnit = Math.floor(vtShare / assetQuantity);

        const adaShare = baseAdaShare + (index < adaRemainder ? 1 : 0);
        const adaSharePerUnit = Math.floor(adaShare / assetQuantity);

        // Get asset price
        const price = Number(asset.floor_price) || Number(asset.dex_price) || Number(asset.listing_price) || 0;
        const key = `${asset.policy_id}:${asset.asset_id}`;

        allVtAssets.set(key, {
          policyId: asset.policy_id,
          assetName: asset.asset_id,
          quantity: assetQuantity,
          multiplier: vtSharePerUnit,
          price,
        });

        allAdaAssets.set(key, {
          policyId: asset.policy_id,
          assetName: asset.asset_id,
          quantity: assetQuantity,
          adaMultiplier: adaSharePerUnit,
          price,
        });

        // Group by policy AND price
        const groupKey = `${asset.policy_id}:${price}`;
        if (!assetsByPolicyAndPrice.has(groupKey)) {
          assetsByPolicyAndPrice.set(groupKey, []);
        }
        assetsByPolicyAndPrice.get(groupKey)!.push({
          assetName: asset.asset_id,
          quantity: assetQuantity,
          multiplier: vtSharePerUnit,
          adaMultiplier: adaSharePerUnit,
          price,
        });
      });
    }

    // Group price buckets by policy
    const policiesData = new Map<
      string,
      {
        priceGroups: Map<number, AssetWithPrice[]>;
        totalAssets: number;
      }
    >();

    for (const [groupKey, assets] of assetsByPolicyAndPrice.entries()) {
      const [policyId, priceStr] = groupKey.split(':');
      const price = Number(priceStr);

      if (!policiesData.has(policyId)) {
        policiesData.set(policyId, { priceGroups: new Map(), totalAssets: 0 });
      }
      const policyData = policiesData.get(policyId)!;
      policyData.priceGroups.set(price, assets);
      policyData.totalAssets += assets.length;
    }

    // Build VT multiplier group details
    const vtMultiplierGroups: Array<{
      policyId: string;
      policyName?: string;
      multiplier: number;
      maxMultiplier: number;
      multiplierVariance: number;
      assetCount: number;
      isGrouped: boolean;
      groupingReason: string;
      assets: Array<{ assetName: string; quantity: number; multiplier: number }>;
    }> = [];

    const adaDistributionGroups: Array<{
      policyId: string;
      policyName?: string;
      adaMultiplier: number;
      maxAdaMultiplier: number;
      multiplierVariance: number;
      assetCount: number;
      isGrouped: boolean;
      groupingReason: string;
      assets: Array<{ assetName: string; quantity: number; adaMultiplier: number }>;
    }> = [];

    for (const [policyId, policyData] of policiesData.entries()) {
      const { priceGroups, totalAssets } = policyData;
      const uniquePrices = priceGroups.size;
      const meetsThreshold = totalAssets >= GROUPING_THRESHOLD;

      // Collect all assets for this policy
      const allPolicyAssets: AssetWithPrice[] = [];
      for (const assets of priceGroups.values()) {
        allPolicyAssets.push(...assets);
      }

      const vtMultipliers = allPolicyAssets.map(a => a.multiplier);
      const adaMultipliers = allPolicyAssets.map(a => a.adaMultiplier);
      const minVtMultiplier = Math.min(...vtMultipliers);
      const maxVtMultiplier = Math.max(...vtMultipliers);
      const minAdaMultiplier = Math.min(...adaMultipliers);
      const maxAdaMultiplier = Math.max(...adaMultipliers);
      const vtVariance = maxVtMultiplier - minVtMultiplier;
      const adaVariance = maxAdaMultiplier - minAdaMultiplier;

      // Price-based grouping: group only if single price for all assets in policy
      const isGrouped = uniquePrices === 1 && meetsThreshold;

      let groupingReason: string;
      if (isGrouped) {
        const price = [...priceGroups.keys()][0];
        groupingReason = `Policy-level grouping (${totalAssets} assets, single price: ${price} ADA)`;
      } else if (uniquePrices > 1 && meetsThreshold) {
        const priceList = [...priceGroups.keys()].slice(0, 5).join(', ');
        groupingReason = `NOT grouped - ${uniquePrices} different prices (${priceList}${uniquePrices > 5 ? '...' : ''})`;
      } else {
        groupingReason = `Asset-level entries (${totalAssets} assets < ${GROUPING_THRESHOLD} threshold)`;
      }

      vtMultiplierGroups.push({
        policyId,
        multiplier: minVtMultiplier,
        maxMultiplier: maxVtMultiplier,
        multiplierVariance: vtVariance,
        assetCount: totalAssets,
        isGrouped,
        groupingReason,
        assets: allPolicyAssets.map(a => ({
          assetName: a.assetName,
          quantity: a.quantity,
          multiplier: a.multiplier,
        })),
      });

      adaDistributionGroups.push({
        policyId,
        adaMultiplier: minAdaMultiplier,
        maxAdaMultiplier,
        multiplierVariance: adaVariance,
        assetCount: totalAssets,
        isGrouped,
        groupingReason,
        assets: allPolicyAssets.map(a => ({
          assetName: a.assetName,
          quantity: a.quantity,
          adaMultiplier: a.adaMultiplier,
        })),
      });
    }

    // Detect mixed-value policies (policies with different prices)
    const mixedValuePolicies: Array<{
      policyId: string;
      vtMultipliers: number[];
      adaMultipliers: number[];
    }> = [];

    for (const [policyId, policyData] of policiesData.entries()) {
      if (policyData.priceGroups.size > 1) {
        const allAssets: AssetWithPrice[] = [];
        for (const assets of policyData.priceGroups.values()) {
          allAssets.push(...assets);
        }
        const vtMults = [...new Set(allAssets.map(a => a.multiplier))].sort((a, b) => b - a);
        const adaMults = [...new Set(allAssets.map(a => a.adaMultiplier))].sort((a, b) => b - a);
        mixedValuePolicies.push({
          policyId,
          vtMultipliers: vtMults,
          adaMultipliers: adaMults,
        });
      }
    }

    // Calculate compression statistics
    const vtOriginalAssetCount = allVtAssets.size;
    const vtFinalEntryCount = acquireMultiplier.filter(m => m[0] !== '').length;
    const vtGroupedPolicies = vtMultiplierGroups.filter(g => g.isGrouped).length;
    const vtUngroupedAssets = vtMultiplierGroups.filter(g => !g.isGrouped).reduce((sum, g) => sum + g.assetCount, 0);

    const adaOriginalAssetCount = allAdaAssets.size;
    const adaFinalEntryCount = adaDistribution.filter(d => d[0] !== '').length;
    const adaGroupedPolicies = adaDistributionGroups.filter(g => g.isGrouped).length;
    const adaUngroupedAssets = adaDistributionGroups
      .filter(g => !g.isGrouped)
      .reduce((sum, g) => sum + g.assetCount, 0);

    return {
      vtMultiplierGroups,
      adaDistributionGroups,
      stats: {
        totalVtGroups: policiesData.size,
        vtGroupedPolicies,
        vtUngroupedAssets,
        vtOriginalAssetCount,
        vtCompressionRatio:
          vtOriginalAssetCount > 0 ? Math.round((1 - vtFinalEntryCount / vtOriginalAssetCount) * 100) : 0,
        totalAdaGroups: policiesData.size,
        adaGroupedPolicies,
        adaUngroupedAssets,
        adaOriginalAssetCount,
        adaCompressionRatio:
          adaOriginalAssetCount > 0 ? Math.round((1 - adaFinalEntryCount / adaOriginalAssetCount) * 100) : 0,
        mixedValuePolicies,
      },
    };
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

      await this.transactionsService.syncVaultTransactions(vault.id);

      // Calculate total value of contributed assets (this becomes the FDV)
      const assetsValue = await this.taptoolsService.calculateVaultAssetsValue(vault.id);
      const totalContributedValueAda = assetsValue.totalValueAda;

      const vtSupply = vault.ft_token_supply * 10 ** vault.ft_token_decimals || 0;
      const LP_PERCENT = vault.liquidity_pool_contribution * 0.01;

      // Calculate LP tokens with 0% for acquirers
      const { lpAdaAmount, lpVtAmount, vtPrice, fdv, adaPairMultiplier } =
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

      // Check if LP is configured and validate minimum threshold
      const lpAdaInLovelace = Math.floor(lpAdaAmount * 1_000_000);
      const minLpLiquidity = this.systemSettingsService.lpRecommendedMinLiquidity;
      const hasLpConfigured = vault.liquidity_pool_contribution > 0;
      let shouldCreateLpClaim = false;

      if (hasLpConfigured && lpAdaInLovelace < minLpLiquidity) {
        // Vault has LP configured but doesn't meet minimum threshold - FAIL the vault
        this.logger.error(
          `Vault ${vault.id} FAILED: LP configured but insufficient liquidity. ` +
            `LP ADA: ${lpAdaAmount} ADA (${lpAdaInLovelace} lovelace) is below ` +
            `required minimum ${minLpLiquidity / 1_000_000} ADA (${minLpLiquidity} lovelace). ` +
            `Vault will transition to FAILED status and users will be refunded.`
        );

        // Transition vault to failed status
        const cancellationResponse = await this.vaultManagingService.updateVaultMetadataTx({
          vault,
          acquireMultiplier: [],
          adaDistribution: [],
          adaPairMultiplier: 0,
          vaultStatus: SmartContractVaultStatus.CANCELLED,
        });

        if (!cancellationResponse.txHash) {
          this.logger.error(`Failed to get txHash for vault ${vault.id} cancellation transaction`);
          return;
        }

        await this.claimsService.createCancellationClaims(vault, 'insufficient_lp_liquidity');

        await this.executePhaseTransition({
          vaultId: vault.id,
          newStatus: VaultStatus.failed,
          txHash: cancellationResponse.txHash,
          failureReason: VaultFailureReason.INSUFFICIENT_LP_LIQUIDITY,
          failureDetails: {
            lpAdaAmount,
            lpAdaInLovelace,
            minLpLiquidity,
            minLpLiquidityAda: minLpLiquidity / 1_000_000,
            message: `LP liquidity ${lpAdaAmount} ADA is below required minimum ${minLpLiquidity / 1_000_000} ADA`,
          },
        });

        this.eventEmitter.emit('vault.failed', {
          vaultId: vault.id,
          vaultName: vault.name,
          reason: VaultFailureReason.INSUFFICIENT_LP_LIQUIDITY,
          lpAdaAmount,
          minLpLiquidityAda: minLpLiquidity / 1_000_000,
        });

        return;
      }

      if (lpVtAmount > 0 && lpAdaAmount > 0) {
        if (lpAdaInLovelace < minLpLiquidity) {
          this.logger.log(
            `No LP claim created for vault ${vault.id}: ` +
              `LP percentage is 0% or LP liquidity ${lpAdaAmount} ADA is below recommended minimum.`
          );
        } else {
          shouldCreateLpClaim = true;
        }
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
            const isNFT = asset.type === AssetType.NFT;
            const { priceAda } = await this.taptoolsService.getAssetValue(asset.policy_id, asset.asset_id, isNFT);
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
            lovelace_amount: 0, // No ADA for 0% acquirers case
            status: ClaimStatus.PENDING,
            transaction: { id: tx.id },
            metadata: {
              noAcquirers: true,
            },
          });

          contributorClaims.push(claim);
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

      // Create LP claim if it meets minimum liquidity threshold
      if (shouldCreateLpClaim) {
        try {
          const lpClaimExists = await this.claimRepository.exists({
            where: { vault: { id: vault.id }, type: ClaimType.LP },
          });

          if (!lpClaimExists) {
            await this.claimRepository.save({
              vault: { id: vault.id },
              type: ClaimType.LP,
              amount: lpVtAmount,
              status: ClaimStatus.AVAILABLE,
              lovelace_amount: lpAdaInLovelace,
            });

            this.logger.log(`Created LP claim: ${lpVtAmount} VT tokens, ${lpAdaAmount} ADA`);
          }
        } catch (error) {
          this.logger.error(`Failed to create LP claim for vault ${vault.id}:`, error);
        }
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
      const { acquireMultiplier, recalculatedClaimAmounts, recalculatedLovelaceAmounts } =
        this.distributionCalculationService.calculateAcquireMultipliers({
          contributorsClaims: finalContributorClaims,
          acquirerClaims: [], // No acquirers
        });

      // Update contributor claim amounts to match smart contract calculation (qty × multiplier)
      // This ensures the transaction validation will pass
      if (recalculatedClaimAmounts.size > 0 || recalculatedLovelaceAmounts.size > 0) {
        const claimsToUpdate = [];
        for (const claim of finalContributorClaims) {
          const recalculatedVt = recalculatedClaimAmounts.get(claim.id);
          const recalculatedLovelace = recalculatedLovelaceAmounts.get(claim.id);
          const vtNeedsUpdate = recalculatedVt !== undefined && recalculatedVt !== claim.amount;
          const lovelaceNeedsUpdate =
            recalculatedLovelace !== undefined && recalculatedLovelace !== claim.lovelace_amount;

          if (vtNeedsUpdate || lovelaceNeedsUpdate) {
            if (vtNeedsUpdate) {
              this.logger.debug(
                `Updating claim ${claim.id} VT amount from ${claim.amount} to ${recalculatedVt} (diff: ${claim.amount - recalculatedVt})`
              );
              claim.amount = recalculatedVt;
            }
            if (lovelaceNeedsUpdate) {
              this.logger.debug(
                `Updating claim ${claim.id} lovelace_amount from ${claim.lovelace_amount} to ${recalculatedLovelace} (diff: ${claim.lovelace_amount - recalculatedLovelace})`
              );
              claim.lovelace_amount = recalculatedLovelace;
            }
            claimsToUpdate.push(claim);
          }
        }
        if (claimsToUpdate.length > 0) {
          await this.claimRepository.save(claimsToUpdate);
          this.logger.log(`Updated ${claimsToUpdate.length} contributor claim amounts to match multiplier calculation`);
        }
      }

      this.logger.log(
        `Calculated acquire multipliers for ${finalContributorClaims.length} contributors ` + `(no acquirers)`
      );

      // Recalculate optimal decimals now that we have final multiplier values
      // This ensures we don't hit floating point precision issues
      const maxMultiplier = Math.max(...acquireMultiplier.map(m => m[2]), 0);
      const minMultiplier = Math.min(...acquireMultiplier.map(m => m[2]).filter(m => m > 0), Infinity);

      this.logger.log(
        `Vault ${vault.id} multiplier stats (no acquirers): ` +
          `maxMultiplier=${maxMultiplier}, minMultiplier=${minMultiplier === Infinity ? 'N/A' : minMultiplier}`
      );

      const optimalDecimals = this.distributionCalculationService.calculateOptimalDecimals(
        vault.ft_token_supply || 1_000_000,
        maxMultiplier,
        minMultiplier === Infinity ? undefined : minMultiplier
      );

      // Update vault decimals if they changed
      if (optimalDecimals !== vault.ft_token_decimals) {
        this.logger.log(
          `Updating vault ${vault.id} decimals from ${vault.ft_token_decimals} to ${optimalDecimals} ` +
            `(maxMultiplier: ${maxMultiplier}, no acquirers scenario)`
        );
        vault.ft_token_decimals = optimalDecimals;
        await this.vaultRepository.update(vault.id, { ft_token_decimals: optimalDecimals });
      }

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

      // Update asset prices before locking to ensure accurate initial_total_value_ada
      this.logger.log(`Updating asset prices before locking vault ${vault.id}`);
      try {
        await this.taptoolsService.updateAssetPrices([vault.id]);
        // Recalculate vault totals with fresh prices
        await this.taptoolsService.updateMultipleVaultTotals([vault.id]);
      } catch (error) {
        this.logger.error(`Failed to update prices before locking vault ${vault.id}:`, error);
      }

      // Submit token metadata PR now that decimals are finalized
      try {
        this.logger.log(
          `Submitting token metadata PR for vault ${vault.id} with finalized decimals: ${optimalDecimals}`
        );
        await this.metadataRegistryApiService.submitVaultTokenMetadata(vault.id);
      } catch (metadataError) {
        this.logger.error(
          `Failed to submit token metadata for vault ${vault.id}: ${metadataError.message}`,
          metadataError.stack
        );
        // Don't fail the transition - PR submission is non-critical
      }

      // Transition to governance phase
      await this.executePhaseTransition({
        vaultId: vault.id,
        newStatus: VaultStatus.locked,
        phaseStartField: 'governance_phase_start',
        newScStatus: SmartContractVaultStatus.SUCCESSFUL,
        txHash: response.txHash,
        acquire_multiplier: acquireMultiplier,
        ada_distribution: [], // No ADA distribution (no acquirers)
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

  /**
   * Cron job to check for vaults with pending distribution batches.
   * When all claims in the current batch are claimed, processes the next batch.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async handlePendingDistributionBatches(): Promise<void> {
    // Find vaults with pending multipliers (multi-batch in progress)
    const vaultsWithPendingBatches = await this.vaultRepository
      .createQueryBuilder('vault')
      .where('vault.vault_status = :status', { status: VaultStatus.locked })
      .andWhere('vault.pending_multipliers IS NOT NULL')
      .andWhere("vault.pending_multipliers != '[]'::jsonb")
      .getMany();

    for (const vault of vaultsWithPendingBatches) {
      if (this.processingVaults.has(vault.id)) continue;

      try {
        this.processingVaults.add(vault.id);
        await this.processNextDistributionBatch(vault);
      } catch (error) {
        this.logger.error(`Error processing next batch for vault ${vault.id}:`, error);
      } finally {
        this.processingVaults.delete(vault.id);
      }
    }
  }

  /**
   * Process the next distribution batch for a vault with pending multipliers
   */
  private async processNextDistributionBatch(vault: Vault): Promise<void> {
    const currentBatch = vault.current_distribution_batch || 1;

    // Check if all claims in current batch are complete
    const batchComplete = await this.multiBatchDistributionService.isBatchComplete(vault.id, currentBatch);

    if (!batchComplete) {
      this.logger.debug(`Vault ${vault.id}: Batch ${currentBatch} still has pending claims. Skipping.`);
      return;
    }

    this.logger.log(`Vault ${vault.id}: Batch ${currentBatch} complete. Processing next batch...`);

    // Get the next batch of multipliers
    const nextBatch = await this.multiBatchDistributionService.getNextBatch(vault);

    if (!nextBatch) {
      this.logger.log(`Vault ${vault.id}: All distribution batches complete!`);
      // Clear pending data
      await this.multiBatchDistributionService.updateVaultBatchProgress(vault.id, {
        pendingMultipliers: [],
        pendingAdaDistribution: [],
      });
      return;
    }

    // Update vault with next batch of multipliers
    const response = await this.vaultManagingService.updateVaultMetadataTx({
      vault,
      acquireMultiplier: nextBatch.currentBatchMultipliers,
      adaDistribution: nextBatch.currentBatchAdaDistribution,
      adaPairMultiplier: vault.ada_pair_multiplier,
      vaultStatus: SmartContractVaultStatus.SUCCESSFUL,
    });

    if (!response.txHash) {
      this.logger.error(`Failed to submit batch ${nextBatch.batchNumber} for vault ${vault.id}`);
      return;
    }

    // Update vault batch tracking
    await this.multiBatchDistributionService.updateVaultBatchProgress(vault.id, {
      currentBatch: nextBatch.batchNumber,
      pendingMultipliers: nextBatch.remainingMultipliers,
      pendingAdaDistribution: nextBatch.remainingAdaDistribution,
      // Append current batch multipliers to existing ones
      acquireMultiplier: [...(vault.acquire_multiplier || []), ...nextBatch.currentBatchMultipliers],
      adaDistribution: [...(vault.ada_distribution || []), ...nextBatch.currentBatchAdaDistribution],
    });

    // Assign claims to this batch
    await this.multiBatchDistributionService.assignClaimsToBatch(
      vault.id,
      nextBatch.currentBatchMultipliers,
      nextBatch.batchNumber
    );

    this.logger.log(
      `Vault ${vault.id}: Submitted batch ${nextBatch.batchNumber}/${nextBatch.totalBatches}. ` +
        `Multipliers: ${nextBatch.currentBatchMultipliers.length}, ` +
        `Remaining: ${nextBatch.remainingMultipliers.length}`
    );
  }
}
