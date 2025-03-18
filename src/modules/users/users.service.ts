import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../database/user.entity';
import { FileEntity } from '../../database/file.entity';
import { LinkEntity } from '../../database/link.entity';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { AwsService } from '../aws_bucket/aws.service';
import {classToPlain} from "class-transformer";

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(FileEntity)
    private filesRepository: Repository<FileEntity>,
    @InjectRepository(LinkEntity)
    private linksRepository: Repository<LinkEntity>,
    private readonly awsService: AwsService,
  ) {}

  async findByAddress(address: string): Promise<User | undefined> {
    return this.usersRepository.findOne({ where: { address } });
  }

  async getPublicProfile(userId: string): Promise<any> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      relations: ['profile_image', 'banner_image', 'social_links', 'vaults']
    });
    console.log("USER" , user)

    if (!user) {
      throw new BadRequestException('User not found');
    }

    // Calculate total_vaults from the vaults relation
    user.total_vaults = user.vaults?.length || 0;

    // Transform to plain object and remove sensitive data
    const plainUser = classToPlain(user);
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
      relations: ['profile_image', 'banner_image', 'social_links', 'vaults']
    });

    if (!user) {
      throw new BadRequestException('User not found');
    }

    // Calculate total_vaults from the vaults relation
    user.total_vaults = user.vaults?.length || 0;

    return classToPlain(user);
  }

  async updateProfile(userId: string, updateData: UpdateProfileDto): Promise<User> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      relations: ['profile_image', 'banner_image', 'social_links']
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
          url: linkData.url
        });
      });
    }
    return this.usersRepository.save(user);
  }

  async uploadProfileImage(userId: string, file: Express.Multer.File, host: string): Promise<User> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      relations: ['profile_image']
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
        size: file.size
      }
    });
    await this.filesRepository.save(fileEntity);

    // Update user's profile image
    user.profile_image = fileEntity;
    return this.usersRepository.save(user);
  }

  async uploadBannerImage(userId: string, file: Express.Multer.File, host: string): Promise<User> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      relations: ['banner_image']
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
        size: file.size
      }
    });
    await this.filesRepository.save(fileEntity);

    // Update user's banner image
    user.banner_image = fileEntity;
    return this.usersRepository.save(user);
  }
}
