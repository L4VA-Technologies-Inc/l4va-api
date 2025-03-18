import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { VaultsService } from './vaults.service';
import { VaultsController } from './vaults.controller';
import { LifecycleModule } from '../lifecycle/lifecycle.module';
import { Vault } from '../../database/vault.entity';
import {User} from '../../database/user.entity';
import {FileEntity} from '../../database/file.entity';
import {AssetsWhitelistEntity} from '../../database/assetsWhitelist.entity';
import {LinkEntity} from '../../database/link.entity';
import {InvestorsWhitelistEntity} from '../../database/investorsWhitelist.entity';
import {AwsModule} from '../aws_bucket/aws.module';
import {TagEntity} from "../../database/tag.entity";

@Module({
  imports: [
    AwsModule,
    LifecycleModule,
    TypeOrmModule.forFeature([Vault, User, FileEntity, AssetsWhitelistEntity, LinkEntity, InvestorsWhitelistEntity, TagEntity]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        global: true,
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '1d' },
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [VaultsService],
  controllers: [VaultsController],
  exports: [VaultsService],
})
export class VaultsModule {}
