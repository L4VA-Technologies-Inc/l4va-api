import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { classToPlain, instanceToPlain, plainToInstance } from 'class-transformer';
import { Brackets, Repository } from 'typeorm';

import { transformImageToUrl } from '../../helpers';
import { GoogleCloudStorageService } from '../google_cloud/google_bucket/bucket.service';
import { PriceService } from '../price/price.service';

import { PublicProfileRes } from './dto/public-profile.res';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ImageType as UploadProfileImageType } from './dto/upload-profile-image.dto';

import { Asset } from '@/database/asset.entity';
import { FileEntity } from '@/database/file.entity';
import { LinkEntity } from '@/database/link.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { VaultStatus } from '@/types/vault.types';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(Vault)
    private vaultRepository: Repository<Vault>,
    @InjectRepository(Asset)
    private assetRepository: Repository<Asset>,
    @InjectRepository(FileEntity)
    private filesRepository: Repository<FileEntity>,
    @InjectRepository(LinkEntity)
    private linksRepository: Repository<LinkEntity>,
    private readonly gcsService: GoogleCloudStorageService,
    private readonly priceService: PriceService
  ) {}

  async findByAddress(address: string): Promise<User | undefined> {
    return this.usersRepository.findOne({
      where: {
        stake_address: address,
      },
      relations: ['profile_image', 'banner_image', 'social_links'],
    });
  }

  async getPublicProfile(userId: string): Promise<PublicProfileRes> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      relations: ['profile_image', 'banner_image', 'social_links'],
    });

    if (!user) {
      throw new BadRequestException('User not found');
    }

    const statuses = [
      VaultStatus.published,
      VaultStatus.contribution,
      VaultStatus.acquire,
      VaultStatus.locked,
      VaultStatus.burned,
    ];

    const vaultsCount = await this.vaultRepository
      .createQueryBuilder('vault')
      .andWhere('vault.deleted != :deleted', { deleted: true })
      .andWhere('vault.vault_status IN (:...statuses)', { statuses })
      .andWhere(
        new Brackets(qb => {
          qb.where('vault.owner_id = :userId', { userId })
            .orWhere(
              `EXISTS (
              SELECT 1 FROM assets
              WHERE assets.vault_id = vault.id 
              AND assets.added_by = :userId
              AND assets.status IN ('locked', 'distributed')
            )`,
              { userId }
            )
            .orWhere(
              `EXISTS (
              SELECT 1 FROM snapshot
              WHERE snapshot.vault_id = vault.id 
              AND snapshot.address_balances -> :userAddress IS NOT NULL
              ORDER BY snapshot.created_at DESC
              LIMIT 1
            )`,
              { userAddress: user.address }
            );
        })
      )
      .getCount();

    user.total_vaults = vaultsCount || 0;
    const plainUser = instanceToPlain(user);

    delete plainUser.gains;
    delete plainUser.vaults;

    return plainToInstance(PublicProfileRes, plainUser, { excludeExtraneousValues: true });
  }

  async create(userData: Partial<User>): Promise<User> {
    const user = this.usersRepository.create(userData);
    return this.usersRepository.save(user);
  }

  async getProfile(userId: string): Promise<PublicProfileRes> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      relations: ['profile_image', 'banner_image', 'social_links'],
    });

    if (!user) {
      throw new BadRequestException('User not found');
    }

    const statuses = [
      VaultStatus.published,
      VaultStatus.contribution,
      VaultStatus.acquire,
      VaultStatus.locked,
      VaultStatus.burned,
    ];
    const vaultsCount = await this.vaultRepository
      .createQueryBuilder('vault')
      .andWhere('vault.deleted != :deleted', { deleted: true })
      .andWhere('vault.vault_status IN (:...statuses)', { statuses })
      .andWhere(
        new Brackets(qb => {
          qb.where('vault.owner_id = :userId', { userId })
            .orWhere(
              `EXISTS (
              SELECT 1 FROM assets
              WHERE assets.vault_id = vault.id 
              AND assets.added_by = :userId
              AND assets.status IN ('locked', 'distributed')
            )`,
              { userId }
            )
            .orWhere(
              `EXISTS (
              SELECT 1 FROM snapshot
              WHERE snapshot.vault_id = vault.id 
              AND snapshot.address_balances -> :userAddress IS NOT NULL
              ORDER BY snapshot.created_at DESC
              LIMIT 1
            )`,
              { userAddress: user.address }
            );
        })
      )
      .getCount();
    user.total_vaults = vaultsCount || 0;
    const plainedUsers = instanceToPlain(user);

    plainedUsers.totalValueUsd = parseFloat((user.tvl * (await this.priceService.getAdaPrice())).toFixed(2));
    plainedUsers.totalValueAda = user.tvl;

    // Calculate gains as percentage: (gains / initial_investment) * 100
    // initial_investment = current_value - gains
    const gainsAda = user.gains || 0;
    const currentTvl = user.tvl || 0;

    let gainsPercentage = 0;

    if (currentTvl > 0 && gainsAda !== 0) {
      const initialInvestment = currentTvl - gainsAda;

      // Handle edge cases
      if (initialInvestment > 0) {
        // Normal case: handles both gains and losses
        // Example: invested 1000, now has 1200 → gains = 200, percentage = 20%
        // Example: invested 1000, now has 800 → gains = -200, percentage = -20%
        gainsPercentage = parseFloat(((gainsAda / initialInvestment) * 100).toFixed(2));
      } else if (initialInvestment === 0 && gainsAda > 0) {
        // Edge case: gains with zero initial investment (e.g., airdrops, rewards)
        // Cap at a reasonable maximum to avoid division by zero
        gainsPercentage = 99999.99;
      }
      // else: data inconsistency (initialInvestment <= 0 with losses), return 0
    }

    plainedUsers.gains = gainsPercentage;

    return plainToInstance(PublicProfileRes, plainedUsers, { excludeExtraneousValues: true });
  }

  async updateProfile(userId: string, updateData: UpdateProfileDto): Promise<User> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      relations: ['profile_image', 'banner_image', 'social_links'],
    });

    if (!user) {
      throw new BadRequestException('User not found');
    }

    // Update basic profile fields
    if (updateData.name !== undefined) {
      user.name = updateData.name;
    }

    if (updateData.email !== undefined) {
      user.email = updateData.email;
    }

    if (updateData.description !== undefined) {
      user.description = updateData.description;
    }

    // Process profile image file
    if (updateData.profileImage) {
      const profileImgKey = updateData.profileImage.split('image/')[1];
      if (profileImgKey) {
        const profileImg = await this.filesRepository.findOne({
          where: { file_key: profileImgKey },
        });
        if (profileImg) {
          user.profile_image = profileImg;
        }
      }
    }

    // Process banner image file
    if (updateData.bannerImage) {
      const bannerImgKey = updateData.bannerImage.split('image/')[1];
      if (bannerImgKey) {
        const bannerImg = await this.filesRepository.findOne({
          where: { file_key: bannerImgKey },
        });
        if (bannerImg) {
          user.banner_image = bannerImg;
        }
      }
    }

    // Handle social links update
    if (updateData.socialLinks) {
      // Remove existing social links
      if (user.social_links?.length > 0) {
        await this.linksRepository.remove(user.social_links);
      }

      // Create new social links
      updateData.socialLinks.map(linkData => {
        return this.linksRepository.save({
          user: user,
          name: linkData.name,
          url: linkData.url,
        });
      });
    }
    const selectedUser = await this.usersRepository.save(user);

    selectedUser.banner_image = transformImageToUrl(selectedUser.banner_image as FileEntity) as any;
    selectedUser.profile_image = transformImageToUrl(selectedUser.profile_image as FileEntity) as any;

    return classToPlain(selectedUser, { excludeExtraneousValues: true }) as User;
  }

  async updateUserAddress(userId: string, address: string): Promise<void> {
    await this.usersRepository.update(
      {
        id: userId,
      },
      {
        address: address,
      }
    );
  }

  async uploadProfileImage(
    userId: string,
    file: Express.Multer.File,
    imageType: UploadProfileImageType
  ): Promise<User> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      relations: ['profile_image', 'banner_image'],
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const targetField = imageType === UploadProfileImageType.BANNER ? 'banner_image' : 'profile_image';
    const previousFile = user[targetField];

    const uploadedFile = await this.gcsService.uploadImage(file, { imageType });
    user[targetField] = uploadedFile;

    const savedUser = await this.usersRepository.save(user);

    if (previousFile?.file_key && previousFile.file_key !== uploadedFile.file_key) {
      this.gcsService.deleteFile(previousFile.file_key).catch(error => {
        this.logger.warn(`Failed to delete previous image ${previousFile.file_key}: ${error?.message ?? error}`);
      });
    }

    return instanceToPlain(savedUser, { excludeExtraneousValues: true }) as User;
  }
}
