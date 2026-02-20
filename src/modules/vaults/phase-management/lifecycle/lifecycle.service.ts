import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { ClaimsService } from '../../claims/claims.service';
import { TransactionsService } from '../../processing-tx/offchain-tx/transactions.service';
import { ExpansionService } from '../governance/expansion.service';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { Proposal } from '@/database/proposal.entity';
import { TokenRegistry } from '@/database/tokenRegistry.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { DistributionCalculationService } from '@/modules/distribution/distribution-calculation.service';
import { SystemSettingsService } from '@/modules/globals/system-settings/system-settings.service';
import { TaptoolsService } from '@/modules/taptools/taptools.service';
import { MetadataRegistryApiService } from '@/modules/vaults/processing-tx/onchain/metadata-register.service';
import { VaultManagingService } from '@/modules/vaults/processing-tx/onchain/vault-managing.service';
import { TreasuryWalletService } from '@/modules/vaults/treasure/treasure-wallet.service';
import { AssetOriginType, AssetType } from '@/types/asset.types';
import { ClaimStatus, ClaimType } from '@/types/claim.types';
import { ProposalStatus, ProposalType } from '@/types/proposal.types';
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
  private isRunning = false;

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
    @InjectRepository(Proposal)
    private readonly proposalRepository: Repository<Proposal>,
    private readonly vaultManagingService: VaultManagingService,
    private readonly distributionCalculationService: DistributionCalculationService,
    private readonly taptoolsService: TaptoolsService,
    private readonly metadataRegistryApiService: MetadataRegistryApiService,
    private readonly treasuryWalletService: TreasuryWalletService,
    private readonly claimsService: ClaimsService,
    private readonly transactionsService: TransactionsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly systemSettingsService: SystemSettingsService,
    private readonly expansionService: ExpansionService
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleVaultLifecycleTransitions(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Distribution process already running, skipping this execution');
      return;
    }

    try {
      this.isRunning = true;
      await this.handlePublishedToContribution(); // Handle created vault -> contribution transitin
      await this.handleContributionToAcquire(); // Handle contribution -> acquire transitions (also handles direct contribution -> governance for 0% acquire vaults)
      await this.handleAcquireToGovernance(); // Handle acquire -> governance transitions
      await this.handleExpansionToLocked(); // Handle expansion -> locked transitions
    } finally {
      this.isRunning = false;
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

  /**
   * Calculate multipliers, update claim amounts, and compute optimal decimals.
   * This is the single source of truth for the claim recalculation flow.
   *
   * Flow:
   * 1. Calculate acquire multipliers and recalculated claim amounts
   * 2. Update contributor claims with recalculated VT and lovelace amounts
   * 3. Calculate optimal decimals based on multiplier values
   * 4. Update vault decimals if changed
   *
   * @returns All data needed for updateVaultMetadataTx call
   */
  private async processMultipliersAndUpdateClaims(params: {
    vault: Vault;
    contributorClaims: Claim[];
    acquirerClaims: Claim[];
  }): Promise<{
    acquireMultiplier: [string, string | null, number][];
    adaDistribution: [string, string | null, number][];
    optimalDecimals: number;
  }> {
    const { vault, contributorClaims, acquirerClaims } = params;

    // Step 1: Calculate multipliers (pure calculation, no mutations)
    const { acquireMultiplier, adaDistribution, recalculatedClaimAmounts, recalculatedLovelaceAmounts } =
      this.distributionCalculationService.calculateAcquireMultipliers({
        contributorsClaims: contributorClaims,
        acquirerClaims: acquirerClaims,
      });

    // Step 2: Update contributor claims with recalculated amounts to match smart contract calculation (qty × multiplier)
    if (recalculatedClaimAmounts.size > 0 || recalculatedLovelaceAmounts.size > 0) {
      const claimsToUpdate: Claim[] = [];
      for (const claim of contributorClaims) {
        const recalculatedVt = recalculatedClaimAmounts.get(claim.id);
        const recalculatedLovelace = recalculatedLovelaceAmounts.get(claim.id);
        const vtNeedsUpdate = recalculatedVt !== undefined && recalculatedVt !== claim.amount;
        const lovelaceNeedsUpdate =
          recalculatedLovelace !== undefined && recalculatedLovelace !== claim.lovelace_amount;

        if (vtNeedsUpdate || lovelaceNeedsUpdate) {
          if (vtNeedsUpdate) {
            claim.amount = recalculatedVt;
          }
          if (lovelaceNeedsUpdate) {
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

    // Step 3: Calculate optimal decimals based on multiplier values
    const maxMultiplier = Math.max(...acquireMultiplier.map(m => m[2]), 0);
    const minMultiplier = Math.min(...acquireMultiplier.map(m => m[2]).filter(m => m > 0), Infinity);
    const maxAdaDistribution = Math.max(...adaDistribution.map(d => d[2]), 0);
    const minAdaDistribution = Math.min(...adaDistribution.map(d => d[2]).filter(d => d > 0), Infinity);
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
      minValue === Infinity ? undefined : minValue
    );

    // Step 4: Update vault decimals if changed
    if (optimalDecimals !== vault.ft_token_decimals) {
      this.logger.log(
        `Updating vault ${vault.id} decimals from ${vault.ft_token_decimals} to ${optimalDecimals} ` +
          `(maxMultiplier: ${maxMultiplier}, maxAdaDistribution: ${maxAdaDistribution})`
      );
      vault.ft_token_decimals = optimalDecimals;
      await this.vaultRepository.update(vault.id, { ft_token_decimals: optimalDecimals });
    }

    return {
      acquireMultiplier,
      adaDistribution,
      optimalDecimals,
    };
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
      const now = new Date();

      // Only execute if the custom start time has arrived
      if (now >= transitionTime) {
        await this.executePhaseTransition({
          vaultId: vault.id,
          newStatus: VaultStatus.contribution,
          phaseStartField: 'contribution_phase_start',
          newScStatus: SmartContractVaultStatus.OPEN,
        });
      }
      // Otherwise, skip - the cron will pick it up when time arrives
    }
  }

  /**
   * Handles transition from Contribution phase to Acquire phase.
   * Validates contributed assets against vault's asset whitelist and threshold requirements.
   * If validation fails, vault is marked as Failed and transition to Acquire is blocked.
   * If vault has 0% tokens for acquirers, it skips Acquire phase and transitions directly to Governance after contribution window ends, while still performing validation and potential failure if requirements are not met.
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
      .andWhere('vault.id NOT IN (:...processingIds)', {
        processingIds:
          this.processingVaults.size > 0 ? Array.from(this.processingVaults) : ['00000000-0000-0000-0000-000000000000'], // Dummy UUID to avoid empty array
      })
      .leftJoinAndSelect('vault.owner', 'owner')
      .leftJoinAndSelect('vault.assets_whitelist', 'assets_whitelist')
      .leftJoinAndSelect('vault.assets', 'assets', 'assets.deleted = :deleted', { deleted: false })
      .getMany();

    for (const vault of contributionVaults) {
      // Skip if vault is already being processed (double-check in case of race condition)
      if (this.processingVaults.has(vault.id)) {
        continue;
      }

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
        try {
          this.processingVaults.add(vault.id);
          await this.executeContributionDirectToGovernance(vault);
        } finally {
          this.processingVaults.delete(vault.id);
        }
        return;
      } else {
        try {
          this.processingVaults.add(vault.id);
          await this.executeContributionToAcquireTransition(vault);
        } finally {
          this.processingVaults.delete(vault.id);
        }
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
        }
        // Otherwise, skip - the cron will pick it up when time arrives
      }
    } catch (error) {
      this.logger.error(`Error executing contribution to acquire transition for vault ${vault.id}`, error);
    }
  }

  /**
   * Check for vaults in Acquire phase that have reached their deadline
   * Triggers transition to Governance phase (or failure if threshold not met)
   * Skips vaults with too many failed update-vault transaction attempts
   *
   * Flow:
   * 1. Fetch vaults in Acquire phase that have passed their acquire window deadline
   * 2. For each vault, check if it meets the acquire threshold (total ADA acquired >= required threshold)
   * 3. If threshold met, calculate distributions, update on-chain metadata, and transition to Governance phase
   * 4. If threshold not met, update on-chain metadata to Cancelled, create cancellation claims, and transition to Failed status
   * 5. Emit events for notifications on both success and failure outcomes
   *
   * Note: This function is designed to be idempotent and can safely be retried in case of failures, as it checks the current status of the vault before attempting any transitions.
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
   * - FT assets: Uses DexHunter
   * - NFT assets:  WayUp Marketplace
   * - Fallback to hardcoded prices if API fails
   */
  private async executeAcquireToGovernanceTransition(vault: Vault): Promise<void> {
    try {
      // Sync transactions one more time
      await this.transactionsService.syncVaultTransactions(vault.id);

      try {
        await this.taptoolsService.updateAssetPrices([vault.id]);
      } catch (error) {
        this.logger.error(`Failed to update asset prices for vault ${vault.id}:`, error);
      }

      // 1. First get all relevant transactions for this vault
      const acquisitionTransactions = await this.transactionsRepository.find({
        where: {
          vault_id: vault.id,
          type: TransactionType.acquire,
          status: TransactionStatus.confirmed,
        },
        relations: ['user'],
        order: { created_at: 'ASC' },
      });

      // Calculate total ADA from acquisitions
      let totalAcquiredAda = 0;
      const userAcquiredAdaMap: Record<string, number> = {};

      // Group acquisition transactions by user for total calculations
      for (const tx of acquisitionTransactions) {
        if (!tx.user_id) continue;

        totalAcquiredAda += tx.amount || 0;

        // Track total per user for later calculations
        if (!userAcquiredAdaMap[tx.user_id]) {
          userAcquiredAdaMap[tx.user_id] = 0;
        }
        userAcquiredAdaMap[tx.user_id] += tx.amount || 0;
      }

      const contributionTransactions = await this.transactionsRepository.find({
        where: {
          vault_id: vault.id,
          type: TransactionType.contribute,
          status: TransactionStatus.confirmed,
        },
        relations: ['user'],
        order: { created_at: 'ASC' },
      });

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
        // Use raw units for claim calculations (on-chain minting needs decimal-adjusted amounts)
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

        // Single source of truth: calculate multipliers, update claims, and compute decimals
        const { acquireMultiplier, adaDistribution } = await this.processMultipliersAndUpdateClaims({
          vault,
          contributorClaims: finalContributorClaims,
          acquirerClaims: finalAcquirerClaims,
        });

        // Submit single update transaction with all multipliers
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

        // Recalculate vault totals with fresh prices after successful metadata update
        try {
          await this.taptoolsService.updateMultipleVaultTotals([vault.id]);
        } catch (error) {
          this.logger.error(`Failed to update vault totals for ${vault.id}:`, error);
        }

        // Submit token metadata PR now that decimals are finalized
        try {
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
          acquire_multiplier: acquireMultiplier,
          ada_distribution: adaDistribution,
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
      const freshVault = await this.vaultRepository.findOne({
        where: { id: vault.id },
        select: ['id', 'vault_status'],
      });

      // Check if vault status has already transitioned (race condition safeguard)
      if (freshVault?.vault_status !== VaultStatus.contribution) {
        this.logger.warn(
          `Vault ${vault.id} status changed to ${freshVault?.vault_status} since initial check. ` +
            `Skipping duplicate processing.`
        );
        return;
      }

      await this.transactionsService.syncVaultTransactions(vault.id);

      // Update asset prices BEFORE calculations to use fresh market data
      this.logger.log(`Updating asset prices for vault ${vault.id} before distribution calculations`);
      try {
        await this.taptoolsService.updateAssetPrices([vault.id]);
      } catch (error) {
        this.logger.error(`Failed to update asset prices for vault ${vault.id}:`, error);
        // Continue with cached prices if update fails
      }

      // Calculate total value of contributed assets (this becomes the FDV)
      const assetsValue = await this.taptoolsService.calculateVaultAssetsValue(vault.id);
      const totalContributedValueAda = assetsValue.totalValueAda;

      // Use raw units for claim calculations (on-chain minting needs decimal-adjusted amounts)
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

      // Single source of truth: calculate multipliers, update claims, and compute decimals (no acquirers)
      const { acquireMultiplier, adaDistribution, optimalDecimals } = await this.processMultipliersAndUpdateClaims({
        vault,
        contributorClaims: finalContributorClaims,
        acquirerClaims: [], // No acquirers in direct contribution → governance flow
      });

      // Submit single update transaction with all multipliers
      const response = await this.vaultManagingService.updateVaultMetadataTx({
        vault,
        acquireMultiplier,
        adaDistribution, // Empty array for no acquirers scenario
        adaPairMultiplier,
        vaultStatus: SmartContractVaultStatus.SUCCESSFUL,
      });

      if (!response.txHash) {
        this.logger.error(`Failed to get txHash for vault ${vault.id} metadata update transaction`);
        throw new Error('Failed to update vault metadata');
      }

      // Recalculate vault totals with fresh prices after successful metadata update
      try {
        await this.taptoolsService.updateMultipleVaultTotals([vault.id]);
      } catch (error) {
        this.logger.error(`Failed to update vault totals for ${vault.id}:`, error);
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
        ada_distribution: adaDistribution, // Empty for no acquirers scenario
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
   * Handle transition from Expansion phase back to Locked (governance) phase
   * Runs periodically to check for vaults whose expansion duration has expired OR asset max is reached
   * Calculates and creates claims for new contributors during expansion
   */
  private async handleExpansionToLocked(): Promise<void> {
    const now = new Date();

    // Find vaults in expansion phase whose expansion duration has expired
    const durationExpiredVaults: Pick<
      Vault,
      'id' | 'vault_status' | 'expansion_phase_start' | 'vt_price' | 'ft_token_decimals'
    >[] = await this.vaultRepository
      .createQueryBuilder('vault')
      .where('vault.vault_status = :status', { status: VaultStatus.expansion })
      .andWhere('vault.expansion_phase_start IS NOT NULL')
      .andWhere('vault.expansion_duration IS NOT NULL')
      .andWhere(`vault.expansion_phase_start + (vault.expansion_duration * interval '1 millisecond') <= :now`, { now })
      .andWhere('vault.id NOT IN (:...processingIds)', {
        processingIds:
          this.processingVaults.size > 0 ? Array.from(this.processingVaults) : ['00000000-0000-0000-0000-000000000000'],
      })
      .select([
        'vault.id',
        'vault.vault_status',
        'vault.expansion_phase_start',
        'vault.vt_price',
        'vault.ft_token_decimals',
      ])
      .getMany();

    if (durationExpiredVaults.length > 0) {
      this.logger.log(
        `Found ${durationExpiredVaults.length} vault(s) with expired expansion phase: ${durationExpiredVaults.map(v => v.id).join(', ')}`
      );
    }

    // Find vaults in expansion phase whose asset max has been reached
    const assetMaxReachedVaults = await this.findExpansionVaultsAtAssetMax();

    // Combine both sets, removing duplicates
    const expansionVaultsMap = new Map<
      string,
      Pick<Vault, 'id' | 'vault_status' | 'expansion_phase_start' | 'vt_price' | 'ft_token_decimals'>
    >();
    for (const vault of [...durationExpiredVaults, ...assetMaxReachedVaults]) {
      expansionVaultsMap.set(vault.id, vault);
    }
    const expansionVaults = Array.from(expansionVaultsMap.values());

    for (const vault of expansionVaults) {
      // Skip if vault is already being processed
      if (this.processingVaults.has(vault.id)) {
        continue;
      }

      this.processingVaults.add(vault.id);

      try {
        await this.expansionService.executeExpansionToLockedTransition(vault);
      } catch (error) {
        this.logger.error(
          `Failed to process expansion->locked transition for vault ${vault.id}: ${error.message}`,
          error.stack
        );
      } finally {
        this.processingVaults.delete(vault.id);
      }
    }
  }

  /**
   * Find expansion vaults that have reached their asset maximum
   * Queries expansion proposals to check if currentAssetCount >= assetMax
   */
  private async findExpansionVaultsAtAssetMax(): Promise<
    Pick<Vault, 'id' | 'vault_status' | 'expansion_phase_start' | 'vt_price' | 'ft_token_decimals'>[]
  > {
    // Find all expansion vaults not already being processed
    const expansionVaults: Pick<
      Vault,
      'id' | 'vault_status' | 'expansion_phase_start' | 'vt_price' | 'ft_token_decimals'
    >[] = await this.vaultRepository.find({
      where: {
        vault_status: VaultStatus.expansion,
      },
      select: ['id', 'vault_status', 'expansion_phase_start', 'vt_price', 'ft_token_decimals'],
    });

    const vaultsAtMax: Pick<Vault, 'id' | 'vault_status' | 'expansion_phase_start'>[] = [];

    for (const vault of expansionVaults) {
      if (this.processingVaults.has(vault.id)) {
        continue;
      }

      // Find the active expansion proposal for this vault
      const expansionProposal: Pick<Proposal, 'id' | 'metadata' | 'executionDate'> =
        await this.proposalRepository.findOne({
          where: {
            vaultId: vault.id,
            proposalType: ProposalType.EXPANSION,
            status: ProposalStatus.EXECUTED,
          },
          order: { executionDate: 'DESC' },
          select: ['id', 'metadata', 'executionDate'],
        });

      if (!expansionProposal?.metadata?.expansion) {
        continue;
      }

      const expansionConfig = expansionProposal.metadata.expansion;

      // Skip if no max configured
      if (expansionConfig.noMax || !expansionConfig.assetMax) {
        continue;
      }

      // Check if currentAssetCount >= assetMax
      const currentAssetCount = expansionConfig.currentAssetCount || 0;
      if (currentAssetCount >= expansionConfig.assetMax) {
        this.logger.log(
          `Vault ${vault.id} reached expansion asset max: ${currentAssetCount}/${expansionConfig.assetMax}`
        );
        vaultsAtMax.push(vault);
      }
    }

    return vaultsAtMax;
  }
}
