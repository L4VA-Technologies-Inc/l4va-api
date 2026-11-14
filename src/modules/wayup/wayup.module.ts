import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TreasureWalletModule } from '../vaults/treasure/treasure-wallet.module';

import { WayUpService } from './wayup.service';

import { Asset } from '@/database/asset.entity';
import { Vault } from '@/database/vault.entity';
import { VaultTreasuryWallet } from '@/database/vaultTreasuryWallet.entity';
import { AssetsModule } from '@/modules/vaults/assets/assets.module';
import { BlockchainModule } from '@/modules/vaults/processing-tx/blockchain.module';
import { TransactionsModule } from '@/modules/vaults/processing-tx/transactions/transactions.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Vault, VaultTreasuryWallet, Asset]),
    HttpModule,
    AssetsModule,
    BlockchainModule,
    TreasureWalletModule,
    TransactionsModule,
  ],
  providers: [WayUpService],
  exports: [WayUpService],
})
export class WayUpModule {}
