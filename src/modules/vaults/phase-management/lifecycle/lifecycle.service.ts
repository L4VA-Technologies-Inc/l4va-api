import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';

import { AssetOriginType } from '../../../../types/asset.types';
import { VaultStatus, ContributionWindowType, InvestmentWindowType } from '../../../../types/vault.types';
import { DistributionService } from '../../../distribution/distribution.service';
import { TaptoolsService } from '../../../taptools/taptools.service';
import { ContributionService } from '../contribution/contribution.service';

import { Asset } from '@/database/asset.entity';
import { Vault } from '@/database/vault.entity';

@Injectable()
export class LifecycleService {
  private readonly logger = new Logger(LifecycleService.name);

  constructor(
    @InjectQueue('phaseTransition')
    private phaseTransitionQueue: Queue,
    @InjectRepository(Asset)
    private readonly assetsRepository: Repository<Asset>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    private readonly contributionService: ContributionService,
    private readonly distributionService: DistributionService,
    private readonly taptoolsService: TaptoolsService
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleVaultLifecycleTransitions(): Promise<void> {
    // this.logger.debug('Checking vault lifecycle transitions...');

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
    phaseStartField?: string
  ): Promise<void> {
    const now = new Date();
    const delay = transitionTime.getTime() - now.getTime();
    const ONE_MINUTE_MS = 60 * 1000;

    if (delay <= 0) {
      // If transition time is now or in the past, execute immediately
      await this.executePhaseTransition(vaultId, newStatus, phaseStartField);
    } else if (delay <= ONE_MINUTE_MS) {
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

  private async executePhaseTransition(
    vaultId: string,
    newStatus: VaultStatus,
    phaseStartField?: string
  ): Promise<void> {
    try {
      const vault = await this.vaultRepository.findOne({
        where: { id: vaultId },
      });

      if (!vault) {
        this.logger.error(`Vault ${vaultId} not found for phase transition`);
        return;
      }

      vault.vault_status = newStatus;

      if (phaseStartField) {
        (vault as any)[phaseStartField] = new Date().toISOString();
      }

      await this.vaultRepository.save(vault);

      this.logger.log(
        `Executed immediate phase transition for vault ${vaultId} to ${newStatus}` +
          (phaseStartField ? ` and set ${phaseStartField}` : '')
      );
    } catch (error) {
      this.logger.error(`Failed to execute phase transition for vault ${vaultId}:`, error);
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
      // For immediate acquire start
      if (vault.acquire_open_window_type === InvestmentWindowType.uponAssetWindowClosing) {
        // Calculate total value of assets in the vault
        try {
          const assetsValue = await this.taptoolsService.calculateVaultAssetsValue(vault.id);
          this.logger.log(
            `Vault ${vault.id} total assets value: ${assetsValue.totalValueAda} ADA (${assetsValue.totalValueUsd} USD)`
          );
          vault.total_assets_cost_ada = assetsValue.totalValueAda;
          vault.total_assets_cost_usd = assetsValue.totalValueUsd;

          // Calculate threshold Price
          vault.require_reserved_cost_ada = assetsValue.totalValueAda * (vault.acquire_reserve * 0.01);
          vault.require_reserved_cost_usd = assetsValue.totalValueUsd * (vault.acquire_reserve * 0.01);
        } catch (error) {
          this.logger.error(`Failed to calculate assets value for vault ${vault.id}:`, error);
        }

        await this.executePhaseTransition(vault.id, VaultStatus.acquire, 'acquire_phase_start');
      }
      // For custom acquire start time
      else if (vault.acquire_open_window_type === InvestmentWindowType.custom && vault.acquire_open_window_time) {
        const now = new Date();
        const customTime = new Date(vault.acquire_open_window_time);

        if (now >= customTime) {
          // Calculate total value of assets in the vault
          try {
            const assetsValue = await this.taptoolsService.calculateVaultAssetsValue(vault.id);
            this.logger.log(
              `Vault ${vault.id} total assets value: ${assetsValue.totalValueAda} ADA (${assetsValue.totalValueUsd} USD)`
            );
            vault.total_assets_cost_ada = assetsValue.totalValueAda;
            vault.total_assets_cost_usd = assetsValue.totalValueUsd;

            // Calculate threshold Price
            vault.require_reserved_cost_ada = assetsValue.totalValueAda * (vault.acquire_reserve * 0.01);
            vault.require_reserved_cost_usd = assetsValue.totalValueUsd * (vault.acquire_reserve * 0.01);
          } catch (error) {
            this.logger.error(`Failed to calculate assets value for vault ${vault.id}:`, error);
          }

          await this.executePhaseTransition(vault.id, VaultStatus.acquire, 'acquire_phase_start');
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

      // 1. Group assets by user
      const assetsByUsers = await this.getAssetsGroupedByUser(vault.id);
      const acquirerAdaMap: Record<string, number> = {};
      const contributorValueMap: Record<string, number> = {};
      let totalAcquiredAda = 0;
      let totalContributedValueAda = 0;

      // 2. Iterate over each user's assets and split by phase
      for (const userAssets of assetsByUsers) {
        const userId = userAssets.user_id;
        const assets = userAssets.assets;
        let userAcquiredAda = 0;
        let userContributedValueAda = 0;

        this.logger.log(
          `User ${userId} (${userAssets.user_wallet}) has ${userAssets.total_assets} assets in vault ${vault.id}: ${JSON.stringify(assets)}`
        );

        for (const asset of assets) {
          // Only ADA in acquired assets
          if (asset.origin_type === AssetOriginType.ACQUIRED) {
            userAcquiredAda += asset.quantity || 1;
            this.logger.debug(`User ${userId} asset ${asset.id}: ${asset.quantity} ADA`);
          }
          if (asset.origin_type === AssetOriginType.CONTRIBUTED) {
            try {
              const { priceAda } = await this.taptoolsService.getAssetValue(asset.policy_id, asset.asset_name);
              const quantity = asset.quantity || 1;
              userContributedValueAda += priceAda * quantity;
            } catch (error) {
              this.logger.error(
                `Error getting price for asset ${asset.policy_id}.${asset.asset_name} for user ${userId} in vault ${vault.id}:`,
                error.message
              );
            }
          }

          if (userAcquiredAda > 0) {
            acquirerAdaMap[userId] = userAcquiredAda;
            totalAcquiredAda += userAcquiredAda;
          }
          if (userContributedValueAda > 0) {
            contributorValueMap[userId] = userContributedValueAda;
            totalContributedValueAda += userContributedValueAda;
          }
        }
      }
      this.logger.log(
        `Total acquired ADA across all users in vault ${vault.id}: ${totalAcquiredAda}, ` +
          `Total contributed value ADA: ${totalContributedValueAda}`
      );

      const requiredThresholdAda = vault.require_reserved_cost_ada || 0;
      const meetsThreshold = totalAcquiredAda >= requiredThresholdAda;

      vault.total_acquired_value_ada = totalAcquiredAda;
      await this.vaultRepository.save(vault);

      this.logger.log(
        `Vault ${vault.id} meets the threshold: ` +
          `Total contributed: ${totalAcquiredAda} ADA, ` +
          `Required: ${requiredThresholdAda} ADA`
      );

      if (meetsThreshold) {
        // TODO: Mint tokens and launch the vault
        // For each user, calculate VT received

        // 3. Calculate VT for acquirers
        for (const [userId, adaSent] of Object.entries(acquirerAdaMap)) {
          const vtResult = await this.distributionService.calculateAcquirerExample({
            vaultId: vault.id,
            adaSent,
            numAcquirers: Object.keys(acquirerAdaMap).length,
            totalAcquiredValueAda: totalAcquiredAda,
          });
          this.logger.debug(
            `--- Acquirer ${userId} will receive VT: ${vtResult.vtReceived} (for ADA sent: ${adaSent})`
          );
        }

        // 4. Calculate VT for contributors
        for (const [userId, valueAda] of Object.entries(contributorValueMap)) {
          const vtResult = await this.distributionService.calculateContributorExample({
            vaultId: vault.id,
            valueContributed: valueAda,
            totalTvl: totalContributedValueAda,
          });
          this.logger.debug(
            `--- Contributor ${userId} will receive VT: ${vtResult.vtRetained} (for value contributed: ${valueAda})`
          );
        }

        this.logger.log(`Vault ${vault.id} is ready to be launched`);
      } else {
        this.logger.warn(
          `Vault ${vault.id} does not meet the threshold: ` +
            `Total contributed: ${totalAcquiredAda} ADA, ` +
            `Required: ${requiredThresholdAda} ADA`
        );

        // TODO: Burn the vault and refund assets
        this.logger.warn(`Vault ${vault.id} needs to be burned and assets refunded`);
      }

      // Execute the phase transition using the consistent method
      await this.executePhaseTransition(vault.id, VaultStatus.governance, 'governance_phase_start');
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
      await this.executePhaseTransition(vault.id, VaultStatus.contribution, 'contribution_phase_start');
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
          vault.vault_status = VaultStatus.failed;
          await this.vaultRepository.save(vault);

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

  async getAssetsGroupedByUser(vaultId: string): Promise<
    {
      user_id: string;
      user_wallet: string;
      total_assets: string;
      assets: {
        id: string;
        type: string;
        contract_address: string | null;
        added_at: string;
        quantity: number;
        origin_type: AssetOriginType;
        policy_id: string;
        asset_name: string;
      }[];
    }[]
  > {
    const query = `
      SELECT
        u.id as user_id,
        u.address as user_wallet,
        COUNT(a.id) as total_assets,
        json_agg(
          json_build_object(
            'id', a.id,
            'type', a.type,
            'contract_address', a.contract_address,
            'added_at', a.added_at,
            'quantity', a.quantity,
            'origin_type', a.origin_type,
            'policy_id', a.policy_id,
            'asset_name', a.asset_id
          )
        ) as assets
      FROM
        assets a
      JOIN
        users u ON u.id = a.added_by
      WHERE
        a.vault_id = $1
      GROUP BY
        u.id, u.address
      ORDER BY
        u.address ASC
    `;

    const result = await this.assetsRepository.query(query, [vaultId]);
    return result;
  }

  private async handleInvestmentToGovernance(): Promise<void> {
    const acquireVaults = await this.vaultRepository
      .createQueryBuilder('vault')
      .where('vault.vault_status = :status', { status: VaultStatus.acquire })
      .andWhere('vault.acquire_phase_start IS NOT NULL')
      .andWhere('vault.acquire_window_duration IS NOT NULL')
      .leftJoinAndSelect('vault.assets', 'assets')
      .getMany();

    const now = new Date();

    for (const vault of acquireVaults) {
      const acquireStart = new Date(vault.acquire_phase_start);
      const acquireDurationMs = Number(vault.acquire_window_duration);
      const acquireEnd = new Date(acquireStart.getTime() + acquireDurationMs);

      // If acquire period hasn't ended yet, queue the transition
      if (now < acquireEnd) {
        await this.queuePhaseTransition(vault.id, VaultStatus.governance, acquireEnd, 'governance_phase_start');
        continue;
      }

      if (now >= acquireEnd) {
        // Execute the transition immediately since the time has passed
        await this.executeAcquireToGovernanceTransition(vault);
      }
    }
  }
}
