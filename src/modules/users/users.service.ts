import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { classToPlain, instanceToPlain, plainToInstance } from 'class-transformer';
import { Repository } from 'typeorm';

import { transformImageToUrl } from '../../helpers';
import { AwsService } from '../aws_bucket/aws.service';
import { TaptoolsService } from '../taptools/taptools.service';

import { PublicProfileRes } from './dto/public-profile.res';
import { UpdateProfileDto } from './dto/update-profile.dto';

import { Asset } from '@/database/asset.entity';
import { FileEntity } from '@/database/file.entity';
import { LinkEntity } from '@/database/link.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { AssetOriginType, AssetStatus, AssetType } from '@/types/asset.types';

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
    private readonly awsService: AwsService,
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

    const ownedVaultsCount = await this.vaultRepository.count({
      where: {
        owner: { id: userId },
        deleted: false,
      },
    });

    user.total_vaults = ownedVaultsCount || 0;

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

    const adaPrice = await this.taptoolsService.getAdaPrice();
    const ownedVaultsCount = await this.vaultRepository.count({
      where: {
        owner: { id: userId },
        deleted: false,
      },
    });
    const tvlResult = await this.assetRepository
      .createQueryBuilder('asset')
      .select(
        'SUM(CASE WHEN asset.type = :nftType THEN asset.floor_price::numeric ELSE asset.dex_price::numeric * asset.quantity END)',
        'tvl'
      )
      .where('asset.added_by = :userId', { userId })
      .andWhere('asset.origin_type = :originType', { originType: AssetOriginType.CONTRIBUTED })
      .andWhere('asset.status = :status', { status: AssetStatus.LOCKED })
      .andWhere(
        '(asset.type = :nftType AND asset.floor_price IS NOT NULL) OR (asset.type = :ftType AND asset.dex_price IS NOT NULL)'
      )
      .setParameter('nftType', AssetType.NFT)
      .setParameter('ftType', AssetType.FT)
      .getRawOne();

    const tvl = tvlResult?.tvl ? parseFloat(tvlResult.tvl) : 0;
    user.total_vaults = ownedVaultsCount || 0;
    user.tvl = tvl;
    const plainedUsers = instanceToPlain(user);

    plainedUsers.totalValueUsd = parseFloat((tvl * adaPrice).toFixed(2));
    plainedUsers.totalValueAda = tvl;
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

  async updateUserAddress(userId: string, address: string) {
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

    // Upload image to S3
    const uploadResult = await this.awsService.uploadImage(file, host);

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

    // Upload image to S3
    const uploadResult = await this.awsService.uploadImage(file, host);

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
