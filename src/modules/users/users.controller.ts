import {
  Controller,
  Get,
  Patch,
  Body,
  Request,
  UseGuards,
  Post,
  UseInterceptors,
  UploadedFile,
  Param,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiConsumes } from '@nestjs/swagger';
import { Express } from 'express';

import { ApiDoc } from '../../decorators/api-doc.decorator';
import { AuthGuard } from '../auth/auth.guard';
import { AuthRequest } from '../auth/dto/auth-user.interface';
import { mbMultiplication } from '../google_cloud/google_bucket/bucket.controller';

import { GetPublicProfileParamDto } from './dto/get-public-profile-param.dto';
import { PublicProfileRes } from './dto/public-profile.res';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UploadImageRes } from './dto/upload-image.res';
import { UsersService } from './users.service';

import { User } from '@/database/user.entity';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @ApiDoc({
    summary: 'Get user profile',
    description: "Returns the authenticated user's profile information",
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Get('profile')
  async getProfile(@Request() req: AuthRequest): Promise<PublicProfileRes> {
    const userId = req.user.sub;
    return this.usersService.getProfile(userId);
  }

  @ApiDoc({
    summary: 'Get public user profile',
    description: "Returns a user's public profile information by ID (excludes sensitive data)",
    status: 200,
  })
  @Get('/profile/:id')
  async getPublicProfile(@Param() params: GetPublicProfileParamDto): Promise<PublicProfileRes> {
    return this.usersService.getPublicProfile(params.id);
  }

  @ApiDoc({
    summary: 'Update user profile',
    description: "Update the authenticated user's profile information",
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Patch('profile')
  async updateProfile(@Request() req: AuthRequest, @Body() updateData: UpdateProfileDto): Promise<User> {
    const userId = req.user.sub;
    return this.usersService.updateProfile(userId, updateData);
  }

  @ApiDoc({
    summary: 'Upload profile image',
    description: "Upload and update user's profile image",
    status: 200,
  })
  @ApiConsumes('multipart/form-data')
  @UseGuards(AuthGuard)
  @Post('profile/image')
  @UseInterceptors(FileInterceptor('file'))
  async uploadProfileImage(
    @Request() req: AuthRequest,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 5 * mbMultiplication }), // 5mb
          new FileTypeValidator({ fileType: 'image/*' }),
        ],
      })
    )
    file: Express.Multer.File
  ): Promise<UploadImageRes> {
    const userId = req.user.sub;
    const user = await this.usersService.uploadProfileImage(userId, file, req.get('host'));
    return { user };
  }

  @ApiDoc({
    summary: 'Upload banner image',
    description: "Upload and update user's banner image",
    status: 200,
  })
  @ApiConsumes('multipart/form-data')
  @UseGuards(AuthGuard)
  @Post('profile/banner')
  @UseInterceptors(FileInterceptor('file'))
  async uploadBannerImage(
    @Request() req: AuthRequest,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 5 * mbMultiplication }), // 5mb
          new FileTypeValidator({ fileType: 'image/*' }),
        ],
      })
    )
    file: Express.Multer.File
  ): Promise<UploadImageRes> {
    const userId = req.user.sub;
    const user = await this.usersService.uploadBannerImage(userId, file, req.get('host'));
    return { user };
  }
}
