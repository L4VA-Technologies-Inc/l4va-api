import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { IndexSwapRouteService } from './index-swap-route.service';
import { IndexVaultController } from './index-vault.controller';
import { IndexVaultService } from './index-vault.service';

import { EvmIndexRebalance } from '@/database/evm-index-rebalance.entity';
import { Vault } from '@/database/vault.entity';
import { BlockchainModule } from '@/modules/vaults/processing-tx/onchain/blockchain.module';

@Module({
  imports: [TypeOrmModule.forFeature([Vault, EvmIndexRebalance]), BlockchainModule],
  controllers: [IndexVaultController],
  providers: [IndexVaultService, IndexSwapRouteService],
  exports: [IndexVaultService],
})
export class IndexVaultModule {}
