import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { VaultsService } from './vaults.service';
import { VaultsController } from './vaults.controller';
import { Vault } from '../../database/vault.entity';
import {User} from "../../database/user.entity";
import {FileEntity} from "../../database/file.entity";
import {AssetsWhitelistEntity} from "../../database/assetsWhitelist.entity";
import {LinkEntity} from "../../database/link.entity";

@Module({
  imports: [
    TypeOrmModule.forFeature([Vault, User, FileEntity, AssetsWhitelistEntity, LinkEntity]),
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
