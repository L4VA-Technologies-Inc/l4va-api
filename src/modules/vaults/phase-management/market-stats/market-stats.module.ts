import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { VaultMarketStatsService } from './vault-market-stats.service';

import { Vault } from '@/database/vault.entity';
import { MarketModule } from '@/modules/market/market.module';
import { TaptoolsModule } from '@/modules/taptools/taptools.module';
import { VyfiModule } from '@/modules/vyfi/vyfi.module';

@Module({
  imports: [TypeOrmModule.forFeature([Vault]), MarketModule, VyfiModule, TaptoolsModule],
  providers: [VaultMarketStatsService],
  exports: [VaultMarketStatsService],
})
export class MarketStatsModule {}
