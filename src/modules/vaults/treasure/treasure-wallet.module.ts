import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TransactionsModule } from '../processing-tx/offchain-tx/transactions.module';
import { BlockchainModule } from '../processing-tx/onchain/blockchain.module';

import { TreasuryExtractionController } from './treasury-extraction.controller';
import { TreasuryExtractionService } from './treasury-extraction.service';

import { Asset } from '@/database/asset.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { VaultTreasuryWallet } from '@/database/vaultTreasuryWallet.entity';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    HttpModule,
    BlockchainModule,
    TransactionsModule,
    TypeOrmModule.forFeature([Vault, Transaction, Asset, VaultTreasuryWallet]),
  ],
  controllers: [TreasuryExtractionController],
  providers: [TreasuryExtractionService],
  exports: [TreasuryExtractionService],
})
export class TreasureWalletModule {}
