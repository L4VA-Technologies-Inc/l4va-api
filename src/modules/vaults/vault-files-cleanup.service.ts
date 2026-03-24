import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThanOrEqual, Not, Repository } from 'typeorm';

import { GoogleCloudStorageService } from '../google_cloud/google_bucket/bucket.service';

import { FileEntity } from '@/database/file.entity';
import { Vault } from '@/database/vault.entity';

const DEACTIVATED_THRESHOLD_DAYS = 7;

@Injectable()
export class VaultFilesCleanupService {
  private readonly logger = new Logger(VaultFilesCleanupService.name);

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    private readonly gcsService: GoogleCloudStorageService
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async cleanupInactiveVaultFiles(): Promise<void> {
    this.logger.log('Starting vault files cleanup for deactivated vaults');

    const threshold = new Date();
    threshold.setDate(threshold.getDate() - DEACTIVATED_THRESHOLD_DAYS);

    const vaults = await this.vaultRepository.find({
      where: [
        { deactivated_at: LessThanOrEqual(threshold), vault_image: Not(IsNull()) },
        { deactivated_at: LessThanOrEqual(threshold), ft_token_img: Not(IsNull()) },
        { deactivated_at: LessThanOrEqual(threshold), acquirer_whitelist_csv: Not(IsNull()) },
      ],
      relations: ['vault_image', 'ft_token_img', 'acquirer_whitelist_csv'],
      select: ['id', 'name', 'vault_image', 'ft_token_img', 'acquirer_whitelist_csv'],
    });

    if (vaults.length === 0) {
      this.logger.log('No vaults with files to clean up');
      return;
    }

    this.logger.log(`Found ${vaults.length} deactivated vault(s) with files to clean up`);

    for (const vault of vaults) {
      await this.cleanupVaultFiles(vault);
    }

    this.logger.log('Vault files cleanup completed');
  }

  private async cleanupVaultFiles(vault: Vault): Promise<void> {
    const filesToDelete: FileEntity[] = [
      vault.vault_image as FileEntity,
      vault.ft_token_img as FileEntity,
      vault.acquirer_whitelist_csv as FileEntity,
    ].filter(Boolean);

    if (filesToDelete.length === 0) return;

    // Clear FK references on the vault first to avoid FK constraint violation on FileEntity deletion
    await this.vaultRepository.update(
      { id: vault.id },
      { vault_image: null, ft_token_img: null, acquirer_whitelist_csv: null }
    );

    // Delete each file from GCS and DB
    for (const file of filesToDelete) {
      try {
        await this.gcsService.deleteFile(file.file_key);
        this.logger.log(`Deleted file ${file.file_key} for vault ${vault.id}`);
      } catch (error) {
        this.logger.warn(`Failed to delete file ${file.file_key} for vault ${vault.id}: ${error?.message ?? error}`);
      }
    }
  }
}
