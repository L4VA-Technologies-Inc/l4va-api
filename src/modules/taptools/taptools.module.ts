import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TaptoolsController } from './taptools.controller';
import { TaptoolsService } from './taptools.service';

import { Asset } from '@/database/asset.entity';
import { Market } from '@/database/market.entity';
import { Snapshot } from '@/database/snapshot.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { AlertsModule } from '@/modules/alerts/alerts.module';
import { DexHunterPricingModule } from '@/modules/dexhunter/dexhunter-pricing.module';
import { MarketModule } from '@/modules/market/market.module';
import { AssetsModule } from '@/modules/vaults/assets/assets.module';
import { WayUpPricingModule } from '@/modules/wayup/wayup-pricing.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Vault, User, Asset, Snapshot, Market]),
    AlertsModule,
    AssetsModule,
    DexHunterPricingModule,
    WayUpPricingModule,
    MarketModule,
  ],
  providers: [TaptoolsService],
  exports: [TaptoolsService],
  controllers: [TaptoolsController],
})
export class TaptoolsModule {}
