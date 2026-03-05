import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MarketController } from './market.controller';
import { MarketService } from './market.service';

import { Market } from '@/database/market.entity';
import { SystemSettingsModule } from '@/modules/globals/system-settings/system-settings.module';
import { PriceModule } from '@/modules/price/price.module';
import { MarketStatsModule } from '@/modules/vaults/market-stats/market-stats.module';

@Module({
  imports: [TypeOrmModule.forFeature([Market]), SystemSettingsModule, PriceModule, MarketStatsModule],
  controllers: [MarketController],
  providers: [MarketService],
  exports: [MarketService],
})
export class MarketModule {}
