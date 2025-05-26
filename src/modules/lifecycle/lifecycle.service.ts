import { Injectable, Logger } from '@nestjs/common';
import { Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Vault } from '../../database/vault.entity';
import { ContributionService } from '../contribution/contribution.service';
import { VaultStatus, ContributionWindowType, InvestmentWindowType } from '../../types/vault.types';
import { TaptoolsService } from '../taptools/taptools.service';

@Injectable()
export class LifecycleService {
  private readonly logger = new Logger(LifecycleService.name);

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @Inject(forwardRef(() => ContributionService))
    private readonly contributionService: ContributionService,
    private readonly taptoolsService: TaptoolsService,
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
      .getMany();

    for (const vault of contributionVaults) {
      try {

        const contributionStart = new Date(vault.contribution_phase_start);
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
              this.logger.log(`Vault ${vault.id} total assets value: ${assetsValue.totalValueAda} ADA (${assetsValue.totalValueUsd} USD)`);
              // You can store this information in the vault if needed
              vault.total_assets_cost_ada = assetsValue.totalValueAda;
              vault.total_assets_cost_usd = assetsValue.totalValueUsd;

              //  todo calculate threshold Price
              vault.require_reserved_cost_ada  = assetsValue.totalValueAda *  (vault.acquire_reserve * 0.01);
              vault.require_reserved_cost_usd = assetsValue.totalValueUsd *  (vault.acquire_reserve * 0.01);
            } catch (error) {
              this.logger.error(`Failed to calculate assets value for vault ${vault.id}:`, error);
              // Continue with the transition even if we couldn't calculate the value
            }
            await this.vaultRepository.save(vault);
            this.logger.log(`Vault ${vault.id} moved to acquire phase (immediate start)`);
          }
          // For custom acquire start time
          else if (vault.acquire_open_window_type === InvestmentWindowType.custom &&
                  vault.acquire_open_window_time &&
                  now >= new Date(vault.acquire_open_window_time)) {
            vault.acquire_phase_start = now.toISOString();
            vault.vault_status = VaultStatus.acquire;
            // Sync transactions before checking contribution end time
            await this.contributionService.syncContributionTransactions(vault.id);

            // TODO: need save this data to vault;
            // Calculate total value of assets in the vault
            try {
              const assetsValue = await this.taptoolsService.calculateVaultAssetsValue(vault.id);
              this.logger.log(`Vault ${vault.id} total assets value: ${assetsValue.totalValueAda} ADA (${assetsValue.totalValueUsd} USD)`);
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
      .getMany();

    const now = new Date();

    for (const vault of acquireVaults) {
      const acquireStart = new Date(vault.acquire_phase_start);
      const acquireDurationMs = Number(vault.acquire_window_duration);
      const acquireEnd = new Date(acquireStart.getTime() + acquireDurationMs);

      if (now >= acquireEnd) {
        // todo here we need sync tx one more time
        await this.contributionService.syncContributionTransactions(vault.id);
        // todo then we need select contributed assets and get it's total price

        // todo then we need to use threshold percent to get required value, then
        // todo we need select invested size of assets, and compare required sum and invested
        // todo if there is enough ada to lunch vault, then we need mint token and lunch
        // todo in other cases we need burn vault and refund assets
        vault.governance_phase_start = now.toISOString();
        vault.vault_status = VaultStatus.governance;
        await this.vaultRepository.save(vault);
        this.logger.log(`Vault ${vault.id} has moved to governance phase`);
      }
    }
  }


}
