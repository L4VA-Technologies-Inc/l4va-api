import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Asset } from '@/database/asset.entity';
import { AnvilApiCache } from '@/database/anvil-api-cache.entity';
import { RelicsStakingService } from './relics-staking.service';
import { AnvilApiClient } from './clients/anvil-api.client';
import { AnvilRelicsStakingStrategy } from './strategies/anvil-relics.strategy';

@Module({
  imports: [
    TypeOrmModule.forFeature([Asset, AnvilApiCache]),
  ],
  providers: [
    RelicsStakingService,
    AnvilApiClient,
    AnvilRelicsStakingStrategy,
  ],
  exports: [RelicsStakingService],
})
export class RelicsStakingModule {}
