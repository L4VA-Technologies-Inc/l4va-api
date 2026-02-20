import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { VaultMarketStatsService } from './vault-market-stats.service';

import { Market } from '@/database/market.entity';
import { Vault } from '@/database/vault.entity';
import { TaptoolsModule } from '@/modules/taptools/taptools.module';
import { VyfiModule } from '@/modules/vyfi/vyfi.module';

@Module({
  imports: [TypeOrmModule.forFeature([Vault, Market]), VyfiModule, TaptoolsModule],
  providers: [VaultMarketStatsService],
  exports: [VaultMarketStatsService],
})
export class MarketStatsModule {}
