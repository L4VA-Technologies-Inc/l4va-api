import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TransactionsModule } from '../offchain-tx/transactions.module';

import { WebhookVerificationService } from './blockchain-webhook.service';
import { BlockchainController } from './blockchain.controller';
import { BlockchainService } from './blockchain.service';
import { MetadataRegistryApiService } from './metadata-register.service';
import { VaultInsertingService } from './vault-inserting.service';
import { VaultManagingService } from './vault-managing.service';

import { AssetsWhitelistEntity } from '@/database/assetsWhitelist.entity';
import { TokenRegistry } from '@/database/tokenRegistry.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    HttpModule,
    TransactionsModule,
    TypeOrmModule.forFeature([Vault, Transaction, AssetsWhitelistEntity, TokenRegistry]),
  ],
  controllers: [BlockchainController],
  providers: [
    MetadataRegistryApiService,
    BlockchainService,
    VaultInsertingService,
    WebhookVerificationService,
    VaultManagingService,
  ],
  exports: [
    BlockchainService,
    VaultInsertingService,
    WebhookVerificationService,
    VaultManagingService,
    MetadataRegistryApiService,
  ],
})
export class BlockchainModule {}
