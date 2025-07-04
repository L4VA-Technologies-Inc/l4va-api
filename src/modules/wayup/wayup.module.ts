import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WayupController } from './wayup.controller';
import { WayupService } from './wayup.service';

import { Asset } from '@/database/asset.entity';
import { Vault } from '@/database/vault.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Vault, Asset]), ConfigModule],
  controllers: [WayupController],
  providers: [WayupService],
  exports: [WayupService],
})
export class WayupModule {}
