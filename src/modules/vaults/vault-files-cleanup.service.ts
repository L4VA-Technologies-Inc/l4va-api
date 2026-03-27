import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { GoogleCloudStorageService } from '../google_cloud/google_bucket/bucket.service';

import { Asset } from '@/database/asset.entity';
import { FileEntity } from '@/database/file.entity';
import { Vault } from '@/database/vault.entity';

const DEACTIVATED_THRESHOLD_DAYS = 7;
const ASSET_IMAGES_FOLDER = 'asset-images';

@Injectable()
export class VaultFilesCleanupService {
  private readonly logger = new Logger(VaultFilesCleanupService.name);

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    @InjectRepository(FileEntity)
    private readonly fileRepository: Repository<FileEntity>,
    private readonly gcsService: GoogleCloudStorageService
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async cleanupInactiveVaultFiles(): Promise<void> {
    this.logger.log('Starting vault files cleanup for deactivated vaults');

    const threshold = new Date();
    threshold.setDate(threshold.getDate() - DEACTIVATED_THRESHOLD_DAYS);

    const vaults = await this.vaultRepository
      .createQueryBuilder('vault')
      .where('vault.deactivated_at <= :threshold', { threshold })
      .andWhere(
        `(
          vault.vault_image_id IS NOT NULL
          OR vault.ft_token_img_id IS NOT NULL
          OR vault.acquirer_whitelist_csv_id IS NOT NULL
        )`
      )
      .leftJoinAndSelect('vault.vault_image', 'vault_image')
      .leftJoinAndSelect('vault.ft_token_img', 'ft_token_img')
      .leftJoinAndSelect('vault.acquirer_whitelist_csv', 'acquirer_whitelist_csv')
      .leftJoinAndSelect('vault.assets', 'assets', "assets.image IS NOT NULL AND assets.image LIKE 'ipfs://%'")
      .getMany();

    if (vaults.length === 0) {
      this.logger.log('No vaults with files to clean up');
      return;
    }

    this.logger.log(`Found ${vaults.length} deactivated vault(s) with files to clean up`);

    for (const vault of vaults) {
      await this.cleanupVaultFiles(vault, threshold);
    }

    this.logger.log('Vault files cleanup completed');
  }

  private async cleanupVaultFiles(vault: Vault, threshold: Date): Promise<void> {
    // 1. Clean vault-level files (vault_image, ft_token_img, acquirer_whitelist_csv)
    const vaultFilesToDelete: { file: FileEntity; field: keyof Vault }[] = [];

    if (vault.vault_image) {
      vaultFilesToDelete.push({ file: vault.vault_image as FileEntity, field: 'vault_image' });
    }
    if (vault.ft_token_img) {
      vaultFilesToDelete.push({ file: vault.ft_token_img as FileEntity, field: 'ft_token_img' });
    }
    if (vault.acquirer_whitelist_csv) {
      vaultFilesToDelete.push({
        file: vault.acquirer_whitelist_csv as FileEntity,
        field: 'acquirer_whitelist_csv',
      });
    }

    if (vaultFilesToDelete.length > 0) {
      const updatePayload: Partial<Vault> = {};

      for (const { file, field } of vaultFilesToDelete) {
        try {
          await this.gcsService.deleteFile(file.file_key);
          await this.fileRepository.delete({ id: file.id });
          (updatePayload as any)[field] = null;
          this.logger.log(`Deleted vault file ${file.file_key} for vault ${vault.id}`);
        } catch (error) {
          this.logger.warn(`Failed to delete vault file ${file.file_key}: ${error?.message ?? error}`);
        }
      }

      if (Object.keys(updatePayload).length > 0) {
        await this.vaultRepository.update({ id: vault.id }, updatePayload);
      }
    }

    // 2. Clean asset images (only if not used by any active vault)
    // Note: Asset.image uses a transformer that converts ipfs://... to HTTP .../asset-image/{cid} when loaded.
    // We detect our images by /asset-image/ path, extract cid, and use raw ipfs://{cid} for DB queries.
    const assetsWithOurImage = vault.assets?.filter(a => a.image?.includes('/asset-image/')) ?? [];
    const processedFileKeys = new Set<string>();

    for (const asset of assetsWithOurImage) {
      const cid = asset.image!.split('/').pop()?.split('?')[0];
      if (!cid) continue;

      const fileKey = `${ASSET_IMAGES_FOLDER}/${cid}`;
      if (processedFileKeys.has(fileKey)) continue; // Already handled (same image in multiple assets)

      const fileEntity = await this.fileRepository.findOne({ where: { file_key: fileKey } });
      if (!fileEntity) continue; // External URL, not in our bucket

      const ipfsImage = `ipfs://${cid}`; // Raw DB value (transformer converts to HTTP when loading)

      const usedByActiveVault = await this.assetRepository
        .createQueryBuilder('a')
        .innerJoin('a.vault', 'v')
        .where('a.image = :image', { image: ipfsImage })
        .andWhere('v.deleted = :deleted', { deleted: false })
        .andWhere('(v.deactivated_at IS NULL OR v.deactivated_at > :threshold)', { threshold })
        .getCount();

      if (usedByActiveVault > 0) continue; // Image still used by an active vault

      processedFileKeys.add(fileKey);

      try {
        await this.gcsService.deleteFile(fileKey);
        await this.fileRepository.delete({ id: fileEntity.id });
        this.logger.log(`Deleted asset image ${fileKey} for vault ${vault.id}`);
      } catch (error) {
        this.logger.warn(`Failed to delete asset image ${fileKey}: ${error?.message ?? error}`);
      }
    }
  }
}
