import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AssetsModule } from '../vaults/assets/assets.module';
import { BlockchainModule } from '../vaults/processing-tx/onchain/blockchain.module';
import { TreasureWalletModule } from '../vaults/treasure/treasure-wallet.module';

import { DexHunterPricingService } from './dexhunter-pricing.service';
import { DexHunterController } from './dexhunter.controller';
import { DexHunterService } from './dexhunter.service';

import { Vault } from '@/database/vault.entity';
import { VaultTreasuryWallet } from '@/database/vaultTreasuryWallet.entity';
import { TransactionsModule } from '@/modules/vaults/processing-tx/offchain-tx/transactions.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Vault, VaultTreasuryWallet]),
    AssetsModule,
    BlockchainModule,
    TreasureWalletModule,
    TransactionsModule,
    HttpModule,
  ],
  controllers: [DexHunterController],
  providers: [DexHunterService, DexHunterPricingService],
  exports: [DexHunterService, DexHunterPricingService],
})
export class DexHunterModule {}
