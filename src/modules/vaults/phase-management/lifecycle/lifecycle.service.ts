import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AssetOriginType } from '../../../../types/asset.types';
import { VaultStatus, ContributionWindowType, InvestmentWindowType } from '../../../../types/vault.types';
import { DistributionService } from '../../../distribution/distribution.service';
import { TaptoolsService } from '../../../taptools/taptools.service';
import { VaultManagingService } from '../../processing-tx/onchain/vault-managing.service';
import { VaultsService } from '../../vaults.service';
import { ContributionService } from '../contribution/contribution.service';

import { Asset } from '@/database/asset.entity';
import { Vault } from '@/database/vault.entity';

@Injectable()
export class LifecycleService {
  private readonly logger = new Logger(LifecycleService.name);

  constructor(
    @InjectRepository(Asset)
    private readonly assetsRepository: Repository<Asset>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @Inject(forwardRef(() => ContributionService))
    private readonly contributionService: ContributionService,
    private readonly distributionService: DistributionService,
    private readonly taptoolsService: TaptoolsService,
    @Inject(forwardRef(() => VaultsService))
    private readonly vaultsService: VaultsService,
    @Inject(forwardRef(() => VaultManagingService))
    private readonly vaultContractService: VaultManagingService
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

  private async handlePublishedToContribution(): Promise<void> {
    const now = new Date();

    // Handle immediate start vaults
    const immediateStartVaults = await this.vaultRepository
      .createQueryBuilder('vault')
      .where('vault.vault_status = :status', { status: VaultStatus.published })
      .andWhere('vault.contribution_open_window_type = :type', { type: ContributionWindowType.uponVaultLaunch })
      .getMany();

    for (const vault of immediateStartVaults) {
      vault.contribution_phase_start = now.toISOString();
      vault.vault_status = VaultStatus.contribution;
      await this.vaultRepository.save(vault);
      this.logger.log(`Vault ${vault.id} moved to contribution phase (immediate start)`);
    }

    // Handle custom start time vaults
    const customStartVaults = await this.vaultRepository
      .createQueryBuilder('vault')
      .where('vault.vault_status = :status', { status: VaultStatus.published })
      .andWhere('vault.contribution_open_window_type = :type', { type: ContributionWindowType.custom })
      .andWhere('vault.contribution_open_window_time IS NOT NULL')
      .andWhere('vault.contribution_open_window_time <= :now', { now: now.toISOString() })
      .getMany();

    for (const vault of customStartVaults) {
      vault.contribution_phase_start = now.toISOString();
      vault.vault_status = VaultStatus.contribution;
      await this.vaultRepository.save(vault);
      this.logger.log(`Vault ${vault.id} moved to contribution phase (custom start time)`);
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

      // Skip if contribution period hasn't ended yet
      if (now < contributionEnd) {
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
      try {
        const contributionDurationMs = Number(vault.contribution_duration);
        const contributionEnd = new Date(contributionStart.getTime() + contributionDurationMs);

        if (now >= contributionEnd) {
          // For immediate acquire start
          if (vault.acquire_open_window_type === InvestmentWindowType.uponAssetWindowClosing) {
            vault.acquire_phase_start = now.toISOString();
            vault.vault_status = VaultStatus.acquire;
            // Sync transactions before checking contribution end time

            // TODO: need save this data to vault;
            // Calculate total value of assets in the vault
            try {
              const assetsValue = await this.taptoolsService.calculateVaultAssetsValue(vault.id);
              this.logger.log(
                `Vault ${vault.id} total assets value: ${assetsValue.totalValueAda} ADA (${assetsValue.totalValueUsd} USD)`
              );
              // You can store this information in the vault if needed
              vault.total_assets_cost_ada = assetsValue.totalValueAda;
              vault.total_assets_cost_usd = assetsValue.totalValueUsd;

              //  todo calculate threshold Price
              vault.require_reserved_cost_ada = assetsValue.totalValueAda * (vault.acquire_reserve * 0.01);
              vault.require_reserved_cost_usd = assetsValue.totalValueUsd * (vault.acquire_reserve * 0.01);
            } catch (error) {
              this.logger.error(`Failed to calculate assets value for vault ${vault.id}:`, error);
              // Continue with the transition even if we couldn't calculate the value
            }
            await this.vaultRepository.save(vault);
            this.logger.log(`Vault ${vault.id} moved to acquire phase (immediate start)`);
          }
          // For custom acquire start time
          else if (
            vault.acquire_open_window_type === InvestmentWindowType.custom &&
            vault.acquire_open_window_time &&
            now >= new Date(vault.acquire_open_window_time)
          ) {
            vault.acquire_phase_start = now.toISOString();
            vault.vault_status = VaultStatus.acquire;
            // Sync transactions before checking contribution end time
            await this.contributionService.syncContributionTransactions(vault.id);

            // TODO: need save this data to vault;
            // Calculate total value of assets in the vault
            try {
              const assetsValue = await this.taptoolsService.calculateVaultAssetsValue(vault.id);
              this.logger.log(
                `Vault ${vault.id} total assets value: ${assetsValue.totalValueAda} ADA (${assetsValue.totalValueUsd} USD)`
              );
              // You can store this information in the vault if needed
              // vault.totalValueAda = assetsValue.totalValueAda;
              // vault.totalValueUsd = assetsValue.totalValueUsd;
            } catch (error) {
              this.logger.error(`Failed to calculate assets value for vault ${vault.id}:`, error);
              // Continue with the transition even if we couldn't calculate the value
            }

            await this.vaultRepository.save(vault);
            this.logger.log(`Vault ${vault.id} moved to acquire phase (custom start time)`);
          }
        }
      } catch (error) {
        this.logger.error(`Error processing vault ${vault.id} in handleContributionToInvestment`, error);
        // Continue with the next vault even if one fails
        continue;
      }
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
          'origin_type', a.origin_type
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

      if (now >= acquireEnd) {
        // Sync transactions one more time
        await this.contributionService.syncContributionTransactions(vault.id);

        // Calculate total value of contributed assets in ADA using Taptools
        let totalAcquiredValueAda = 0;
        const userAdaMap: Record<string, number> = {};

        // Group assets by user
        const assetsByUsers = await this.getAssetsGroupedByUser(vault.id);

        // Iterate over each user's assets and calculate their contribution in ADA
        for (const userAssets of assetsByUsers) {
          const userId = userAssets.user_id;
          const userWallet = userAssets.user_wallet;
          const totalAssets = userAssets.total_assets;
          const assets = userAssets.assets;
          this.logger.log(
            `User ${userId} (${userWallet}) has ${totalAssets} assets in vault ${vault.id}: ${JSON.stringify(assets)}`
          );

          let userValueInAda = 0; // <-- Reset for each user

          for (const asset of assets) {
            // Only ADA in acquired assets
            if (asset.origin_type === AssetOriginType.ACQUIRED) {
              if (!asset.id) {
                this.logger.warn(`Skipping asset with missing id for user ${userId} in vault ${vault.id}`);
                continue;
              }
              try {
                // Get asset value from Taptools
                // const { priceAda } = await this.taptoolsService.getAssetValue(asset.contract_address, asset.id);
                // const quantity = asset.quantity || 1;
                // const assetValueAda = priceAda * quantity;

                userValueInAda += asset.quantity || 1;
                this.logger.debug(`User ${userId} asset ${asset.id}: ${asset.quantity || 1} ADA`);
              } catch (error) {
                this.logger.error(
                  `Error getting price for asset ${asset.contract_address}.${asset.id} for user ${userId} in vault ${vault.id}:`,
                  error.message
                );
              }
            }
          }
          userAdaMap[userId] = userValueInAda;
          totalAcquiredValueAda += userValueInAda;
          this.logger.log(`User ${userId} total ADA sent: ${userValueInAda}`);
        }

        const requiredThresholdAda = vault.require_reserved_cost_ada || 0;
        const meetsThreshold = totalAcquiredValueAda >= requiredThresholdAda;

        vault.total_acquired_value_ada = totalAcquiredValueAda;
        await this.vaultRepository.save(vault);

        this.logger.log(
          `Vault ${vault.id} meets the threshold: ` +
            `Total contributed: ${totalAcquiredValueAda} ADA, ` +
            `Required: ${requiredThresholdAda} ADA`
        );

        if (meetsThreshold) {
          // TODO: Mint tokens and launch the vault
          // For each user, calculate VT received
          const userIds = Object.keys(userAdaMap);

          for (const userId of userIds) {
            const adaSent = userAdaMap[userId];
            const vtResult = await this.distributionService.calculateAcquirerExample({
              vaultId: vault.id,
              adaSent,
              numAcquirers: userIds.length,
              totalAcquiredValueAda: totalAcquiredValueAda,
            });
            this.logger.log(`User ${userId} will receive VT: ${vtResult.vtReceived} (for ADA sent: ${adaSent})`);
            // Optionally: Save this info to DB or further process it
          }

          this.logger.log(`Vault ${vault.id} is ready to be launched`);
        } else {
          this.logger.warn(
            `Vault ${vault.id} does not meet the threshold: ` +
              `Total contributed: ${totalAcquiredValueAda} ADA, ` +
              `Required: ${requiredThresholdAda} ADA`
          );

          // TODO: Burn the vault and refund assets
          this.logger.warn(`Vault ${vault.id} needs to be burned and assets refunded`);
        }

        // Move to governance phase regardless of threshold for now
        // In a real implementation, you might want to handle success/failure differently
        vault.governance_phase_start = now.toISOString();
        vault.vault_status = VaultStatus.governance;
        vault.total_assets_cost_ada = totalAcquiredValueAda;

        await this.vaultRepository.save(vault);
        this.logger.log(`Vault ${vault.id} has moved to governance phase`);
      }
    }
  }
}
