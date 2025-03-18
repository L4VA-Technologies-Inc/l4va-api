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
      const contributionEnd = new Date(contributionStart.getTime() + vault.contribution_duration);

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
      const investmentEnd = new Date(investmentStart.getTime() + vault.investment_window_duration);

      if (now >= investmentEnd) {
        vault.locked_at = now.toISOString();
        vault.vault_status = VaultStatus.locked;
        await this.vaultRepository.save(vault);
        this.logger.log(`Vault ${vault.id} has been locked`);
      }
    }
  }


}
