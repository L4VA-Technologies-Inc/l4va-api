import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Vault } from '../../database/vault.entity';
import { TransactionsModule } from '../transactions/transactions.module';

import { AnvilApiService } from './anvil-api.service';
import { BlockchainScannerService } from './blockchain-scanner.service';
import { BlockchainController } from './blockchain.controller';
import { BlockchainService } from './blockchain.service';
import { VaultInsertingService } from './vault-inserting.service';
import { VaultManagingService } from './vault-managing.service';
import { WebhookVerificationService } from './webhook-verification.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    HttpModule,
    TransactionsModule,
    TypeOrmModule.forFeature([Vault]),
  ],
  controllers: [BlockchainController],
  providers: [
    BlockchainService,
    VaultInsertingService,
    AnvilApiService,
    BlockchainScannerService,
    WebhookVerificationService,
    VaultManagingService,
  ],
  exports: [
    BlockchainService,
    VaultInsertingService,
    WebhookVerificationService,
    VaultManagingService,
    BlockchainScannerService,
  ],
})
export class BlockchainModule {}
