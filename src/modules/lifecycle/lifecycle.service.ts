import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Vault } from '../../database/vault.entity';
import { VaultStatus, ContributionWindowType, InvestmentWindowType } from '../../types/vault.types';

@Injectable()
export class LifecycleService {
  private readonly logger = new Logger(LifecycleService.name);

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleVaultLifecycleTransitions() {
    this.logger.debug('Checking vault lifecycle transitions...');

    await this.handlePublishedToContribution();

    // Handle contribution -> investment transitions
    await this.handleContributionToInvestment();

    // Handle investment -> governance transitions
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
      const contributionStart = new Date(vault.contribution_phase_start);
      const contributionDurationMs = Number(vault.contribution_duration);
      const contributionEnd = new Date(contributionStart.getTime() + contributionDurationMs);

      if (now >= contributionEnd) {
        // For immediate investment start
        if (vault.investment_open_window_type === InvestmentWindowType.uponAssetWindowClosing) {
          vault.investment_phase_start = now.toISOString();
          vault.vault_status = VaultStatus.investment;
          await this.vaultRepository.save(vault);
          this.logger.log(`Vault ${vault.id} moved to investment phase (immediate start)`);
        }
        // For custom investment start time
        else if (vault.investment_open_window_type === InvestmentWindowType.custom &&
                 vault.investment_open_window_time &&
                 now >= new Date(vault.investment_open_window_time)) {
          vault.investment_phase_start = now.toISOString();
          vault.vault_status = VaultStatus.investment;
          await this.vaultRepository.save(vault);
          this.logger.log(`Vault ${vault.id} moved to investment phase (custom start time)`);
        }
      }
    }
  }

  private async handleInvestmentToGovernance() {
    const investmentVaults = await this.vaultRepository
      .createQueryBuilder('vault')
      .where('vault.vault_status = :status', { status: VaultStatus.investment })
      .andWhere('vault.investment_phase_start IS NOT NULL')
      .andWhere('vault.investment_window_duration IS NOT NULL')
      .getMany();

    const now = new Date();

    for (const vault of investmentVaults) {
      const investmentStart = new Date(vault.investment_phase_start);
      const investmentDurationMs = Number(vault.investment_window_duration);
      const investmentEnd = new Date(investmentStart.getTime() + investmentDurationMs);

      if (now >= investmentEnd) {
        vault.governance_phase_start = now.toISOString();
        vault.vault_status = VaultStatus.governance;
        await this.vaultRepository.save(vault);
        this.logger.log(`Vault ${vault.id} has moved to governance phase`);
      }
    }
  }


}
