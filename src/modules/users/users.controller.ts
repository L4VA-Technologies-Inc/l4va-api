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
  HttpCode,
  Delete,
  ParseUUIDPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiConsumes } from '@nestjs/swagger';
import { Express } from 'express';

import { ApiDoc } from '../../decorators/api-doc.decorator';
import { AuthGuard } from '../auth/auth.guard';
import { AuthRequest } from '../auth/dto/auth-user.interface';
import { mbMultiplication } from '../google_cloud/google_bucket/bucket.controller';

import { GetPublicProfileParamDto } from './dto/get-public-profile-param.dto';
import { LinkedWalletRes } from './dto/linked-wallet.res';
import { PublicProfileRes } from './dto/public-profile.res';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UploadImageRes } from './dto/upload-image.res';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { EmailVerificationService } from './email-verification.service';
import { UsersService } from './users.service';
import { WalletLinkService } from './wallet-link.service';

import { User } from '@/database/user.entity';
import { ImageType, UploadProfileImageDto } from '@/modules/users/dto/upload-profile-image.dto';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly emailVerificationService: EmailVerificationService,
    private readonly walletLinkService: WalletLinkService
  ) {}

  @ApiDoc({
    summary: 'Verify email',
    description: 'Confirms the email address using the token from the verification link',
    status: 200,
  })
  @Post('email/verify')
  @HttpCode(200)
  async verifyEmail(@Body() body: VerifyEmailDto): Promise<{ email: string; emailVerified: boolean }> {
    return this.emailVerificationService.verify(body.token);
  }

  @ApiDoc({
    summary: 'Resend verification email',
    description: 'Sends a new verification link to the email on the authenticated user profile',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Post('email/resend-verification')
  @HttpCode(200)
  async resendEmailVerification(@Request() req: AuthRequest): Promise<{ success: boolean }> {
    await this.emailVerificationService.resendVerification(req.user.sub);
    return { success: true };
  }

  @ApiDoc({
    summary: 'Get linked wallets',
    description:
      'Returns wallets linked to the authenticated user through the same verified email (max one per chain), including the current wallet',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Get('linked-wallets')
  async getLinkedWallets(@Request() req: AuthRequest): Promise<LinkedWalletRes[]> {
    return this.walletLinkService.getLinkedWallets(req.user.sub);
  }

  @ApiDoc({
    summary: 'Unlink wallet',
    description: 'Removes the email from a wallet linked to the authenticated user, breaking the cross-chain link',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Delete('linked-wallets/:userId')
  @HttpCode(200)
  async unlinkWallet(
    @Request() req: AuthRequest,
    @Param('userId', ParseUUIDPipe) targetUserId: string
  ): Promise<{ success: boolean }> {
    await this.walletLinkService.unlinkWallet(req.user.sub, targetUserId);
    return { success: true };
  }

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

  @UseGuards(AuthGuard)
  @Post('profile/image')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('image'))
  async uploadProfileImage(
    @Request() req: AuthRequest,
    @Body() body: UploadProfileImageDto,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 5 * mbMultiplication }),
          new FileTypeValidator({ fileType: 'image/.*' }),
        ],
      })
    )
    file: Express.Multer.File
  ): Promise<UploadImageRes> {
    const userId = req.user.sub;
    const user = await this.usersService.uploadProfileImage(userId, file, body.imageType ?? ImageType.AVATAR);

    return { user };
  }
}
