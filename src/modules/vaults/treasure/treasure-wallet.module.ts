import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TransactionsModule } from '../processing-tx/offchain-tx/transactions.module';
import { BlockchainModule } from '../processing-tx/onchain/blockchain.module';

import { TreasuryWalletService } from './treasure-wallet.service';
import { TreasuryExtractionService } from './treasury-extraction.service';

import { Asset } from '@/database/asset.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { VaultTreasuryWallet } from '@/database/vaultTreasuryWallet.entity';
import { GoogleCloudModule } from '@/modules/google_cloud/google-cloud.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    HttpModule,
    BlockchainModule,
    TransactionsModule,
    GoogleCloudModule,
    TypeOrmModule.forFeature([Vault, Transaction, Asset, VaultTreasuryWallet]),
  ],
  providers: [TreasuryWalletService, TreasuryExtractionService],
  exports: [TreasuryWalletService, TreasuryExtractionService],
})
export class TreasureWalletModule {}
