import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { classToPlain, instanceToPlain, plainToInstance } from 'class-transformer';
import { Brackets, Repository } from 'typeorm';

import { transformImageToUrl } from '../../helpers';
import { GoogleCloudStorageService } from '../google_cloud/google_bucket/bucket.service';
import { TaptoolsService } from '../taptools/taptools.service';

import { PublicProfileRes } from './dto/public-profile.res';
import { UpdateProfileDto } from './dto/update-profile.dto';

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
    private readonly taptoolsService: TaptoolsService
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
    plainUser.banner_image = user.banner_image?.file_url || null;
    plainUser.profile_image = user.profile_image?.file_url || null;

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

    plainedUsers.totalValueUsd = parseFloat((user.tvl * (await this.taptoolsService.getAdaPrice())).toFixed(2));
    plainedUsers.totalValueAda = user.tvl;

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

  async uploadProfileImage(userId: string, file: Express.Multer.File, host: string): Promise<User> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      relations: ['profile_image'],
    });

    if (!user) {
      throw new BadRequestException('User not found');
    }

    const uploadResult = await this.gcsService.uploadImage(file, host);

    const fileEntity = this.filesRepository.create({
      file_key: uploadResult.file_key,
      file_url: uploadResult.file_url,
      file_type: file.mimetype,
      file_name: file.originalname,
      metadata: {
        size: file.size,
      },
    });
    await this.filesRepository.save(fileEntity);

    // Update user's profile image
    user.profile_image = fileEntity;
    return this.usersRepository.save(user);
  }

  async uploadBannerImage(userId: string, file: Express.Multer.File, host: string): Promise<User> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      relations: ['banner_image'],
    });

    if (!user) {
      throw new BadRequestException('User not found');
    }

    const uploadResult = await this.gcsService.uploadImage(file, host);

    // Create or update file entity
    const fileEntity = this.filesRepository.create({
      file_key: uploadResult.file_key,
      file_url: uploadResult.file_url,
      file_type: file.mimetype,
      file_name: file.originalname,
      metadata: {
        size: file.size,
      },
    });
    await this.filesRepository.save(fileEntity);

    // Update user's banner image
    user.banner_image = fileEntity;
    return this.usersRepository.save(user);
  }
}
