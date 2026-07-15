import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AnvilApiClient } from './clients/anvil-api.client';
import { RelicsStakingService } from './relics-staking.service';
import { AnvilRelicsStakingStrategy } from './strategies/anvil-relics.strategy';

import { Asset } from '@/database/asset.entity';
import { VaultStakingPosition } from '@/database/vault-staking-position.entity';
import { RedisModule } from '@/modules/redis/redis.module';
import { BlockchainModule } from '@/modules/vaults/processing-tx/onchain/blockchain.module';
import { TreasureWalletModule } from '@/modules/vaults/treasure/treasure-wallet.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Asset, VaultStakingPosition]),
    TreasureWalletModule,
    BlockchainModule,
    RedisModule,
  ],
  providers: [RelicsStakingService, AnvilApiClient, AnvilRelicsStakingStrategy],
  exports: [RelicsStakingService, AnvilRelicsStakingStrategy],
})
export class RelicsStakingModule {}
