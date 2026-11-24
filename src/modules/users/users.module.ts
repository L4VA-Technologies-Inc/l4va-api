import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { GoogleCloudStorageModule } from '../google_cloud/google_bucket/bucket.module';
import { NotificationModule } from '../notification/notification.module';

import { EmailVerificationService } from './email-verification.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { WalletLinkService } from './wallet-link.service';

import { Asset } from '@/database/asset.entity';
import { FileEntity } from '@/database/file.entity';
import { LinkEntity } from '@/database/link.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, FileEntity, LinkEntity, Vault, Asset]),
    GoogleCloudStorageModule,
    NotificationModule,
  ],
  controllers: [UsersController],
  providers: [UsersService, EmailVerificationService, WalletLinkService],
  exports: [UsersService, WalletLinkService],
})
export class UsersModule {}
