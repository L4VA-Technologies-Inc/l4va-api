import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Vault } from 'src/database/vault.entity';
import { AssetOriginType, AssetStatus, AssetType } from '../../../../types/asset.types';
import { VaultStatus, ContributionWindowType, InvestmentWindowType } from '../../../../types/vault.types';
import { TaptoolsService } from '../../../taptools/taptools.service';
import { VaultManagingService } from '../../processing-tx/onchain/vault-managing.service';
import { VaultsService } from '../../vaults.service';
import { ContributionService } from '../contribution/contribution.service';

@Injectable()
export class LifecycleService {
  private readonly logger = new Logger(LifecycleService.name);

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @Inject(forwardRef(() => ContributionService))
    private readonly contributionService: ContributionService,
    private readonly taptoolsService: TaptoolsService,
    @Inject(forwardRef(() => VaultsService))
    private readonly vaultsService: VaultsService,
    @Inject(forwardRef(() => VaultManagingService))
    private readonly vaultContractService: VaultManagingService
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleVaultLifecycleTransitions() {
    // this.logger.debug('Checking vault lifecycle transitions...');

    await this.handlePublishedToContribution();

    // Handle contribution -> acquire transitions
    await this.handleContributionToInvestment();

    // Handle acquire -> governance transitions
    await this.handleInvestmentToGovernance();
  }

  private async handlePublishedToContribution() {
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

  private async handleContributionToInvestment() {
    const now = new Date();
    const contributionVaults = await this.vaultRepository
      .createQueryBuilder('vault')
      .where('vault.vault_status = :status', { status: VaultStatus.contribution })
      .andWhere('vault.contribution_phase_start IS NOT NULL')
      .andWhere('vault.contribution_duration IS NOT NULL')
      .leftJoinAndSelect('vault.assets', 'assets')
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

      // Check if vault has any non-deleted assets
      const hasAssets = vault.assets?.some(asset => !asset.deleted) || false;

      // If no assets, burn the vault using admin wallet
      if (!hasAssets) {
        try {
          this.logger.log(`Vault ${vault.id} has no assets and contribution period has ended. Burning vault...`);
          //
          // // Use admin wallet to burn the vault
          // const burnTx = await this.vaultContractService.createBurnTx({
          //   customerAddress: vault.owner.address, // Still track the original owner
          //   assetVaultName: vault.asset_vault_name
          // });
          //
          // // Submit the transaction using admin wallet
          // const { txHash } = await this.vaultContractService.submitOnChainVaultTx({
          //   transaction: burnTx.presignedTx,
          //   signatures: [] // Admin signature is already included in presignedTx
          // });
          //
          // // Update vault status
          // vault.deleted = true;
          // vault.liquidation_hash = txHash;
          // await this.vaultRepository.save(vault);
          //
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
            await this.contributionService.syncContributionTransactions(vault.id);

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

  private async handleInvestmentToGovernance() {
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

        // Get all contributed assets for this vault
        const contributedAssets =
          vault.assets?.filter(
            asset =>
              asset.origin_type === AssetOriginType.CONTRIBUTED &&
              asset.status === AssetStatus.PENDING &&
              !asset.deleted
          ) || [];

        // Calculate total value of contributed assets in ADA using Taptools
        let totalContributedValueAda = 0;

        // Process each asset to get its value from Taptools
        for (const asset of contributedAssets) {
          try {
            // Skip if no policy_id or asset_id
            if (!asset.policy_id || !asset.asset_id) {
              this.logger.warn(`Skipping asset with missing policy_id or asset_id in vault ${vault.id}`);
              continue;
            }

            // Get asset value from Taptools
            const assetValue = await this.taptoolsService.getAssetValue(asset.policy_id, asset.asset_id);

            // Calculate total value for this asset (price * quantity)
            const quantity = asset.quantity || 1;
            const assetValueAda = assetValue.priceAda * quantity;
            totalContributedValueAda += assetValueAda;

            this.logger.debug(
              `Asset ${asset.policy_id}.${asset.asset_id}: ` +
                `${quantity} x ${assetValue.priceAda} ADA = ${assetValueAda} ADA`
            );
          } catch (error) {
            this.logger.error(
              `Error getting price for asset ${asset.policy_id}.${asset.asset_id} in vault ${vault.id}:`,
              error.message
            );
            // Continue processing other assets even if one fails
          }
        }

        // Get the required threshold value (in ADA)
        const requiredThresholdAda = vault.require_reserved_cost_ada || 0;

        // Check if the vault meets the threshold
        const meetsThreshold = totalContributedValueAda >= requiredThresholdAda;

        // Log the decision
        if (meetsThreshold) {
          this.logger.log(
            `Vault ${vault.id} meets the threshold: ` +
              `Total contributed: ${totalContributedValueAda} ADA, ` +
              `Required: ${requiredThresholdAda} ADA`
          );

          // TODO: Mint tokens and launch the vault
          this.logger.log(`Vault ${vault.id} is ready to be launched`);
        } else {
          this.logger.warn(
            `Vault ${vault.id} does not meet the threshold: ` +
              `Total contributed: ${totalContributedValueAda} ADA, ` +
              `Required: ${requiredThresholdAda} ADA`
          );

          // TODO: Burn the vault and refund assets
          this.logger.warn(`Vault ${vault.id} needs to be burned and assets refunded`);
        }

        // Move to governance phase regardless of threshold for now
        // In a real implementation, you might want to handle success/failure differently
        vault.governance_phase_start = now.toISOString();
        vault.vault_status = VaultStatus.governance;
        vault.total_assets_cost_ada = totalContributedValueAda;

        await this.vaultRepository.save(vault);
        this.logger.log(`Vault ${vault.id} has moved to governance phase`);
      }
    }
  }
}
