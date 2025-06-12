import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { classToPlain, plainToInstance } from 'class-transformer';
import { Repository } from 'typeorm';

import { FileEntity } from '../../database/file.entity';
import { LinkEntity } from '../../database/link.entity';
import { User } from '../../database/user.entity';
import { transformImageToUrl } from '../../helpers';
import { AwsService } from '../aws_bucket/aws.service';

import { PublicProfileRes } from './dto/public-profile.res';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(FileEntity)
    private filesRepository: Repository<FileEntity>,
    @InjectRepository(LinkEntity)
    private linksRepository: Repository<LinkEntity>,
    private readonly awsService: AwsService
  ) {}

  async findByAddress(address: string): Promise<User | undefined> {
    return this.usersRepository.findOne({
      where: {
        stake_address: address,
      },
      relations: ['profile_image', 'banner_image', 'social_links'],
    });
  }

  async getPublicProfile(userId: string): Promise<any> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      relations: ['profile_image', 'banner_image', 'social_links'],
    });
    this.logger.log('USER', user);

    if (!user) {
      throw new BadRequestException('User not found');
    }

    // Calculate total_vaults from the vaults relation
    user.total_vaults = user.vaults?.length || 0;

    const userSource = {
      ...user,
      banner_image: user.banner_image.file_url,
      profile_image: user.profile_image.file_url,
    };

    // Transform to plain object and remove sensitive data
    const plainUser = classToPlain(userSource);
    delete plainUser.address;
    delete plainUser.gains;
    delete plainUser.vaults;

    return plainUser;
  }

  async create(userData: Partial<User>): Promise<User> {
    const user = this.usersRepository.create(userData);
    return this.usersRepository.save(user);
  }

  async getProfile(userId: string): Promise<any> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      relations: ['profile_image', 'banner_image', 'social_links'],
    });

    if (!user) {
      throw new BadRequestException('User not found');
    }

    // Calculate total_vaults from the vaults relation
    user.total_vaults = user.vaults?.length || 0;
    const plainedUsers = classToPlain(user);
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
