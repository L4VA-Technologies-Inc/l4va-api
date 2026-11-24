import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EvmV13LpSaleService } from './evm-v13-lp-sale.service';
import { IndexSwapRouteService } from './index-swap-route.service';
import { IndexVaultController } from './index-vault.controller';
import { IndexVaultService } from './index-vault.service';
import { UniswapTradingApiClient } from './swap-route/uniswap-trading-api.client';

import { EvmIndexRebalance } from '@/database/evm-index-rebalance.entity';
import { EvmValuationSnapshot } from '@/database/evm-valuation-snapshot.entity';
import { Vault } from '@/database/vault.entity';
import { AlertsModule } from '@/modules/alerts/alerts.module';
import { BlockchainModule } from '@/modules/vaults/processing-tx/onchain/blockchain.module';

@Module({
  imports: [TypeOrmModule.forFeature([Vault, EvmIndexRebalance, EvmValuationSnapshot]), BlockchainModule, AlertsModule],
  controllers: [IndexVaultController],
  providers: [IndexVaultService, IndexSwapRouteService, UniswapTradingApiClient, EvmV13LpSaleService],
  exports: [IndexVaultService, IndexSwapRouteService, EvmV13LpSaleService],
})
export class IndexVaultModule {}
