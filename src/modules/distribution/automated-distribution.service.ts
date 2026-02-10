import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, MoreThan, Not, Repository } from 'typeorm';

import { MultiBatchDistributionService } from './multi-batch-distribution.service';
import { AcquirerDistributionOrchestrator } from './orchestrators/acquirer-distribution.orchestrator';
import {
  ContributorDistributionOrchestrator,
  InsufficientUtxosException,
} from './orchestrators/contributor-distribution.orchestrator';

import { Claim } from '@/database/claim.entity';
import { Vault } from '@/database/vault.entity';
import { GovernanceService } from '@/modules/vaults/phase-management/governance/governance.service';
import { BlockchainService } from '@/modules/vaults/processing-tx/onchain/blockchain.service';
import { VyfiService } from '@/modules/vyfi/vyfi.service';
import { ClaimStatus, ClaimType } from '@/types/claim.types';
import { VaultStatus, SmartContractVaultStatus } from '@/types/vault.types';

/**
 * Automated Distribution Service
 *
 * Main coordinator for vault distribution workflows:
 * - Orchestrates acquirer extraction and contributor payment flows
 * - Manages vault state transitions through distribution lifecycle
 * - Coordinates stake registration and finalization
 *
 * Flow:
 * 1. processLockedVaultsForDistribution() → Start distribution for locked vaults
 * 2. AcquirerDistributionOrchestrator → Extract acquirer claims (if applicable)
 * 3. Register stake credential
 * 4. ContributorDistributionOrchestrator → Pay contributors
 * 5. finalizeVaultDistribution() → Create LP & snapshot
 */
@Injectable()
export class AutomatedDistributionService {
  private readonly logger = new Logger(AutomatedDistributionService.name);
  private readonly adminHash: string;
  private readonly SC_POLICY_ID: string;
  private readonly adminSKey: string;
  private readonly adminAddress: string;
  private readonly unparametizedDispatchHash: string;
  private isRunning = false;

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Claim)
    private readonly claimRepository: Repository<Claim>,
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService,
    private readonly governanceService: GovernanceService,
    private readonly vyfiService: VyfiService,
    private readonly acquirerOrchestrator: AcquirerDistributionOrchestrator,
    private readonly contributorOrchestrator: ContributorDistributionOrchestrator,
    private readonly multiBatchDistributionService: MultiBatchDistributionService
  ) {
    this.unparametizedDispatchHash = this.configService.get<string>('DISPATCH_SCRIPT_HASH');
    this.adminHash = this.configService.get<string>('ADMIN_KEY_HASH');
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
    this.SC_POLICY_ID = this.configService.get<string>('SC_POLICY_ID');
    this.adminAddress = this.configService.get<string>('ADMIN_ADDRESS');
  }

  /**
   * Get configuration object for orchestrators
   */
  private getConfig(): {
    adminAddress: string;
    adminHash: string;
    adminSKey: string;
    unparametizedDispatchHash: string;
  } {
    return {
      adminAddress: this.adminAddress,
      adminHash: this.adminHash,
      adminSKey: this.adminSKey,
      unparametizedDispatchHash: this.unparametizedDispatchHash,
    };
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async processVaultDistributions(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Distribution process already running, skipping this execution');
      return;
    }

    this.isRunning = true;

    try {
      // Step 1: Find vaults ready for distribution and start acquirer extractions
      await this.processLockedVaultsForDistribution();

      // Step 2: Check extraction completion and trigger contributor payments
      await this.checkExtractionsAndTriggerPayments();
    } catch (error) {
      this.logger.error('Error in vault distribution process:', error);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Find locked vaults ready for distribution and initiate acquirer extractions
   */
  private async processLockedVaultsForDistribution(): Promise<void> {
    const readyVaults: Pick<
      Vault,
      'id' | 'tokens_for_acquires' | 'dispatch_parametized_hash' | 'script_hash' | 'asset_vault_name'
    >[] = await this.vaultRepository.find({
      where: {
        vault_status: VaultStatus.locked,
        vault_sc_status: SmartContractVaultStatus.SUCCESSFUL,
        last_update_tx_hash: Not(IsNull()),
        distribution_processed: false,
        created_at: MoreThan(new Date('2025-10-22')),
      },
      select: ['id', 'tokens_for_acquires', 'dispatch_parametized_hash', 'script_hash', 'asset_vault_name'],
    });

    for (const vault of readyVaults) {
      try {
        this.logger.log(`Processing vault ${vault.id} for distribution`);

        await this.vaultRepository.update({ id: vault.id }, { distribution_in_progress: true });

        await this.ensureDispatchParameterized(vault);

        if (Number(vault.tokens_for_acquires) === 0) {
          this.logger.log(
            `Vault ${vault.id} has 0% tokens for acquirers. ` +
              `Skipping acquirer extractions, proceeding directly to contributor payments.`
          );
          continue; // Will be picked up by checkExtractionsAndTriggerPayments
        }

        // Delegate to acquirer orchestrator
        await this.acquirerOrchestrator.processAcquirerExtractions(vault.id, this.getConfig());
      } catch (error) {
        this.logger.error(`Error processing vault ${vault.id}:`, error);
      }
    }
  }

  /**
   * Check if acquirer extractions are complete and trigger contributor payments
   * For multi-batch vaults, only processes claims for the current batch
   */
  private async checkExtractionsAndTriggerPayments(): Promise<void> {
    const vaultsWithClaims = await this.vaultRepository
      .createQueryBuilder('vault')
      .select([
        'vault.id',
        'vault.stake_registered',
        'vault.asset_vault_name',
        'vault.script_hash',
        'vault.dispatch_parametized_hash',
        'vault.dispatch_preloaded_script',
        'vault.tokens_for_acquires',
        'vault.last_update_tx_hash',
        'vault.acquire_multiplier',
        'vault.current_distribution_batch',
        'vault.total_distribution_batches',
        'vault.pending_multipliers',
        'vault.manual_distribution_mode',
      ])
      .leftJoin(
        'claims',
        'claim',
        'claim.vault_id = vault.id AND claim.type = :type AND claim.status IN (:...statuses)',
        {
          type: ClaimType.ACQUIRER,
          statuses: [ClaimStatus.PENDING, ClaimStatus.FAILED],
        }
      )
      .addSelect('COUNT(claim.id)', 'remainingAcquirerClaims')
      .where('vault.distribution_processed = :processed', { processed: false })
      .andWhere('vault.distribution_in_progress = :inProgress', { inProgress: true })
      .groupBy('vault.id')
      .getRawAndEntities();

    const vaults = vaultsWithClaims.entities;
    const claimCounts = vaultsWithClaims.raw;

    if (vaults.length === 0) {
      return;
    }

    this.logger.log(`Found ${vaults.length} vaults in distribution to check`);

    for (let i = 0; i < vaults.length; i++) {
      const vault = vaults[i];
      const remainingAcquirerClaims = parseInt(claimCounts[i].remainingAcquirerClaims || '0');

      try {
        // Check if this is a multi-batch vault with pending batches
        const hasMultipleBatches = vault.total_distribution_batches && vault.total_distribution_batches > 1;
        const hasPendingBatches = vault.pending_multipliers && vault.pending_multipliers.length > 0;
        const currentBatch = vault.current_distribution_batch || 1;

        if (hasMultipleBatches) {
          this.logger.log(
            `Vault ${vault.id} is multi-batch: batch ${currentBatch}/${vault.total_distribution_batches}` +
              (hasPendingBatches ? ` (${vault.pending_multipliers.length} pending multipliers)` : '')
          );
        }

        // For multi-batch vaults, count only claims in current batch
        let remainingClaimsForCurrentBatch = remainingAcquirerClaims;
        if (hasMultipleBatches) {
          remainingClaimsForCurrentBatch = await this.claimRepository.count({
            where: {
              vault_id: vault.id,
              type: ClaimType.ACQUIRER,
              distribution_batch: currentBatch,
              status: In([ClaimStatus.PENDING, ClaimStatus.FAILED]),
            },
          });
        }

        this.logger.log(
          `Checking vault ${vault.id} - ${remainingClaimsForCurrentBatch} acquirer claims remaining` +
            (hasMultipleBatches ? ` (batch ${currentBatch})` : '')
        );

        // Check if vault has 0% for acquirers (skip acquirer check)
        const shouldSkipAcquirerCheck = vault.tokens_for_acquires === 0;

        if (!shouldSkipAcquirerCheck && remainingClaimsForCurrentBatch > 0) {
          this.logger.log(
            `Vault ${vault.id} still has ${remainingClaimsForCurrentBatch} acquirer claims pending. ` +
              `Skipping contributor payments for now.`
          );
          continue;
        }

        this.logger.log(
          shouldSkipAcquirerCheck
            ? `Vault ${vault.id} has 0% for acquirers, proceeding to contributor payments.`
            : `All acquirer extractions complete for vault ${vault.id}` +
                (hasMultipleBatches ? ` (batch ${currentBatch})` : '')
        );

        // Delegate to contributor orchestrator (it will handle batch-aware processing)
        await this.contributorOrchestrator.processContributorPayments(vault.id, vault, this.getConfig());

        // Check if all payments complete for this batch
        const isCurrentBatchComplete = await this.contributorOrchestrator.arePaymentsComplete(vault.id, currentBatch);

        if (isCurrentBatchComplete) {
          // For multi-batch vaults, check if all batches are complete
          if (hasPendingBatches) {
            this.logger.log(
              `Batch ${currentBatch} complete for vault ${vault.id}. ` +
                `Waiting for next batch to be processed by lifecycle service.`
            );
            // Don't finalize yet - lifecycle service will handle next batch
            continue;
          }

          // Check if all batches are truly complete
          const allBatchesComplete = await this.multiBatchDistributionService.isAllBatchesComplete(vault.id);
          if (!allBatchesComplete) {
            this.logger.log(`Vault ${vault.id} has more batches pending. Skipping finalization.`);
            continue;
          }

          this.logger.log(`All contributor payments complete for vault ${vault.id}, finalizing...`);
          await this.finalizeVaultDistribution(vault.id, vault.script_hash, vault.asset_vault_name);
        }
      } catch (error) {
        // Handle insufficient UTXOs - stop processing this vault and wait for next cron cycle
        if (error instanceof InsufficientUtxosException) {
          this.logger.warn(
            `Vault ${vault.id} has insufficient UTXOs. Skipping remaining processing. ` +
              `Will retry in next cron cycle (10 minutes).`
          );
          continue;
        }

        this.logger.error(`Error processing vault ${vault.id} for contributor payments:`, error);
      }
    }

    this.logger.log('Completed checking extractions and triggering payments for all vaults');
  }

  /**
   * Ensure dispatch script is parameterized for vault
   */
  private async ensureDispatchParameterized(
    vault: Pick<Vault, 'id' | 'dispatch_parametized_hash' | 'asset_vault_name' | 'script_hash'>
  ): Promise<void> {
    if (vault.dispatch_parametized_hash) {
      return;
    }

    this.logger.log(`Parameterizing dispatch script for vault ${vault.id}`);

    try {
      const dispatchResult = await this.blockchainService.applyDispatchParameters({
        vault_policy: this.SC_POLICY_ID,
        vault_id: vault.asset_vault_name,
        contribution_script_hash: vault.script_hash,
      });

      await this.vaultRepository.update(
        { id: vault.id },
        {
          dispatch_parametized_hash: dispatchResult.parameterizedHash,
          dispatch_preloaded_script: dispatchResult.fullResponse,
        }
      );

      this.logger.log(`Successfully parameterized dispatch script for vault ${vault.id}`);
    } catch (error) {
      this.logger.error(`Error parameterizing dispatch script for vault ${vault.id}:`, error);
      throw error;
    }
  }

  /**
   * Finalize vault distribution: create LP and governance snapshot
   */
  private async finalizeVaultDistribution(
    vaultId: string,
    script_hash: string,
    asset_vault_name: string
  ): Promise<void> {
    try {
      const vault: Pick<
        Vault,
        'id' | 'liquidity_pool_contribution' | 'governance_phase_start' | 'total_assets_cost_ada'
      > = await this.vaultRepository.findOne({
        where: { id: vaultId },
        select: ['id', 'liquidity_pool_contribution', 'governance_phase_start', 'total_assets_cost_ada'],
      });

      if (!vault) {
        throw new Error(`Vault ${vaultId} not found`);
      }

      const lpPercent = vault.liquidity_pool_contribution || 0;

      // Check if LP claim exists for this vault
      const lpClaim = await this.claimRepository.findOne({
        where: { vault: { id: vaultId }, type: ClaimType.LP, status: ClaimStatus.AVAILABLE },
      });

      // Create LP if LP percentage > 0 AND LP claim exists
      if (lpPercent > 0 && lpClaim) {
        const { withdrawalTxHash, lpCreationTxHash } =
          await this.vyfiService.createLiquidityPoolWithWithdrawal(vaultId);
        this.logger.log(
          `LP created for vault ${vaultId}. ` + `Withdrawal: ${withdrawalTxHash}, LP Creation: ${lpCreationTxHash}`
        );
      } else if (lpPercent > 0 && !lpClaim) {
        this.logger.log(
          `Vault ${vaultId} has LP contribution but no LP claim (likely ADA < 500). Skipping LP creation.`
        );
      } else {
        this.logger.log(`Vault ${vaultId} has 0% LP contribution. Skipping liquidity pool creation.`);
      }

      // Mark vault as fully processed
      await this.vaultRepository.update(
        { id: vaultId },
        {
          distribution_in_progress: false,
          distribution_processed: true,
        }
      );

      // Create governance snapshot
      try {
        await this.governanceService.createAutomaticSnapshot(vaultId, `${script_hash}${asset_vault_name}`);
      } catch (error) {
        this.logger.error(`Error creating governance snapshot for vault ${vaultId}:`, error);
      }

      this.logger.log(
        `Vault ${vaultId} distribution finalized successfully ` + `(LP: ${lpPercent > 0 ? 'created' : 'skipped'})`
      );
    } catch (error) {
      this.logger.error(`Failed to finalize vault distribution for ${vaultId}:`, error);
      await this.vaultRepository.update({ id: vaultId }, { distribution_in_progress: false });
      throw error;
    }
  }
}
