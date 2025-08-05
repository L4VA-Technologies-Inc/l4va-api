import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TransactionsModule } from '../offchain-tx/transactions.module';

import { AnvilApiService } from './anvil-api.service';
import { BlockchainScannerService } from './blockchain-scanner.service';
import { BlockchainController } from './blockchain.controller';
import { BlockchainService } from './blockchain.service';
import { VaultInsertingService } from './vault-inserting.service';
import { VaultManagingService } from './vault-managing.service';
import { WebhookVerificationService } from './webhook-verification.service';

import { AssetsWhitelistEntity } from '@/database/assetsWhitelist.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    HttpModule,
    TransactionsModule,
    TypeOrmModule.forFeature([Vault, Transaction, AssetsWhitelistEntity]),
  ],
  controllers: [BlockchainController],
  providers: [
    AnvilApiService,
    BlockchainService,
    VaultInsertingService,
    BlockchainScannerService,
    WebhookVerificationService,
    VaultManagingService,
  ],
  exports: [
    BlockchainService,
    VaultInsertingService,
    BlockchainScannerService,
    WebhookVerificationService,
    VaultManagingService,
  ],
})
export class BlockchainModule {}
