import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { VaultMarketStatsService } from './vault-market-stats.service';
import { VaultTvlCalculationService } from './vault-tvl-calculation.service';

import { Asset } from '@/database/asset.entity';
import { Market } from '@/database/market.entity';
import { Vault } from '@/database/vault.entity';
import { DexHunterPricingModule } from '@/modules/dexhunter/dexhunter-pricing.module';
import { TaptoolsModule } from '@/modules/taptools/taptools.module';

@Module({
  imports: [TypeOrmModule.forFeature([Vault, Market, Asset]), DexHunterPricingModule, TaptoolsModule],
  providers: [VaultMarketStatsService, VaultTvlCalculationService],
  exports: [VaultMarketStatsService, VaultTvlCalculationService],
})
export class MarketStatsModule {}
