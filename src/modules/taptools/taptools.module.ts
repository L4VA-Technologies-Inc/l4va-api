import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { VyfiModule } from '../vyfi/vyfi.module';

import { TaptoolsController } from './taptools.controller';
import { TaptoolsService } from './taptools.service';

import { Asset } from '@/database/asset.entity';
import { Market } from '@/database/market.entity';
import { Snapshot } from '@/database/snapshot.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { AlertsModule } from '@/modules/alerts/alerts.module';
import { Charli3PricingModule } from '@/modules/charli3/charli3-pricing.module';
import { DexHunterPricingModule } from '@/modules/dexhunter/dexhunter-pricing.module';
import { RedisModule } from '@/modules/redis/redis.module';
import { TapToolsPricingModule } from '@/modules/taptools/taptools-pricing.module';
import { AssetsModule } from '@/modules/vaults/assets/assets.module';
import { WayUpPricingModule } from '@/modules/wayup/wayup-pricing.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Vault, User, Asset, Snapshot, Market]),
    AlertsModule,
    AssetsModule,
    Charli3PricingModule,
    DexHunterPricingModule,
    RedisModule,
    TapToolsPricingModule,
    WayUpPricingModule,
    VyfiModule,
  ],
  providers: [TaptoolsService],
  exports: [TaptoolsService],
  controllers: [TaptoolsController],
})
export class TaptoolsModule {}
