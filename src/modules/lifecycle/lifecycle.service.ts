import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Vault } from '../../database/vault.entity';
import { VaultStatus } from '../../types/vault.types';

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
    
    // Handle published -> contribution transitions
    await this.handlePublishedToContribution();
    
    // Handle contribution -> investment transitions
    await this.handleContributionToInvestment();
    
    // Handle investment -> locked transitions
    await this.handleInvestmentToLocked();
  }

  private async handlePublishedToContribution() {
    const publishedVaults = await this.vaultRepository
      .createQueryBuilder('vault')
      .where('vault.vault_status = :status', { status: VaultStatus.published })
      .andWhere('vault.contribution_open_window_type = :type', { type: 'upon-vault-lunch' })
      .getMany();

    for (const vault of publishedVaults) {
      vault.contribution_phase_start = new Date().toISOString();
      vault.vault_status = VaultStatus.contribution;
      await this.vaultRepository.save(vault);
      this.logger.log(`Vault ${vault.id} moved to contribution phase`);
    }
  }

  private async handleContributionToInvestment() {
    const contributionVaults = await this.vaultRepository
      .createQueryBuilder('vault')
      .where('vault.vault_status = :status', { status: VaultStatus.contribution })
      .andWhere('vault.contribution_phase_start IS NOT NULL')
      .andWhere('vault.contribution_duration IS NOT NULL')
      .getMany();

    const now = new Date();

    for (const vault of contributionVaults) {
      const contributionStart = new Date(vault.contribution_phase_start);
      const contributionDuration = vault.contribution_duration;
      
      // Parse PostgreSQL interval to milliseconds
      const durationMs = this.parseIntervalToMs(contributionDuration);
      const contributionEnd = new Date(contributionStart.getTime() + durationMs);

      if (now >= contributionEnd) {
        vault.investment_phase_start = now.toISOString();
        vault.vault_status = VaultStatus.investment;
        await this.vaultRepository.save(vault);
        this.logger.log(`Vault ${vault.id} moved to investment phase`);
      }
    }
  }

  private async handleInvestmentToLocked() {
    const investmentVaults = await this.vaultRepository
      .createQueryBuilder('vault')
      .where('vault.vault_status = :status', { status: VaultStatus.investment })
      .andWhere('vault.investment_phase_start IS NOT NULL')
      .andWhere('vault.investment_window_duration IS NOT NULL')
      .getMany();

    const now = new Date();

    for (const vault of investmentVaults) {
      const investmentStart = new Date(vault.investment_phase_start);
      const investmentDuration = vault.investment_window_duration;
      
      // Parse PostgreSQL interval to milliseconds
      const durationMs = this.parseIntervalToMs(investmentDuration);
      const investmentEnd = new Date(investmentStart.getTime() + durationMs);

      if (now >= investmentEnd) {
        vault.locked_at = now.toISOString();
        vault.vault_status = VaultStatus.locked;
        await this.vaultRepository.save(vault);
        this.logger.log(`Vault ${vault.id} has been locked`);
      }
    }
  }

  private parseIntervalToMs(interval: string): number {
    // Example interval format: '1 year 2 months 3 days 4 hours 5 minutes'
    const parts = interval.toLowerCase().match(/(\d+)\s+(year|month|day|hour|minute|second)s?/g) || [];
    let totalMs = 0;

    for (const part of parts) {
      const [value, unit] = part.split(/\s+/);
      const numValue = parseInt(value, 10);

      switch (unit) {
        case 'year':
          totalMs += numValue * 365 * 24 * 60 * 60 * 1000;
          break;
        case 'month':
          totalMs += numValue * 30 * 24 * 60 * 60 * 1000;
          break;
        case 'day':
          totalMs += numValue * 24 * 60 * 60 * 1000;
          break;
        case 'hour':
          totalMs += numValue * 60 * 60 * 1000;
          break;
        case 'minute':
          totalMs += numValue * 60 * 1000;
          break;
        case 'second':
          totalMs += numValue * 1000;
          break;
      }
    }

    return totalMs;
  }
}
