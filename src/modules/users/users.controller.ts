import { ApiTags, ApiConsumes } from '@nestjs/swagger';
import { Controller, Get, Patch, Body, Request, UseGuards, Post, UseInterceptors, UploadedFile, Param } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { AuthGuard } from '../auth/auth.guard';
import { ApiDoc } from '../../decorators/api-doc.decorator';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @ApiDoc({
    summary: 'Get user profile',
    description: 'Returns the authenticated user\'s profile information',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Get('profile')
  async getProfile(@Request() req) {
    const userId = req.user.sub;
    return this.usersService.getProfile(userId);
  }

  @ApiDoc({
    summary: 'Get public user profile',
    description: 'Returns a user\'s public profile information by ID (excludes sensitive data)',
    status: 200,
  })
  @Get('/profile/:id')
  async getPublicProfile(@Param('id') userId: string) {
    return this.usersService.getPublicProfile(userId);
  }

  @ApiDoc({
    summary: 'Update user profile',
    description: 'Update the authenticated user\'s profile information',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Patch('profile')
  async updateProfile(
    @Request() req,
    @Body() updateData: UpdateProfileDto,
  ) {
    const userId = req.user.sub;
    return this.usersService.updateProfile(userId, updateData);
  }

  @ApiDoc({
    summary: 'Upload profile image',
    description: 'Upload and update user\'s profile image',
    status: 200,
  })
  @ApiConsumes('multipart/form-data')
  @UseGuards(AuthGuard)
  @Post('profile/image')
  @UseInterceptors(FileInterceptor('file'))
  async uploadProfileImage(
    @Request() req,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const userId = req.user.sub;
    return this.usersService.uploadProfileImage(userId, file, req.get('host'));
  }

  @ApiDoc({
    summary: 'Upload banner image',
    description: 'Upload and update user\'s banner image',
    status: 200,
  })
  @ApiConsumes('multipart/form-data')
  @UseGuards(AuthGuard)
  @Post('profile/banner')
  @UseInterceptors(FileInterceptor('file'))
  async uploadBannerImage(
    @Request() req,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const userId = req.user.sub;
    return this.usersService.uploadBannerImage(userId, file, req.get('host'));
  }

}
