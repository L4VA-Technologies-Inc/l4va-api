import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { GoogleCloudStorageModule } from '../google_cloud/google_bucket/bucket.module';
import { TaptoolsModule } from '../taptools/taptools.module';

import { UsersController } from './users.controller';
import { UsersService } from './users.service';

import { Asset } from '@/database/asset.entity';
import { FileEntity } from '@/database/file.entity';
import { LinkEntity } from '@/database/link.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, FileEntity, LinkEntity, Vault, Asset]),
    GoogleCloudStorageModule,
    TaptoolsModule,
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
