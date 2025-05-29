import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { BlockchainService } from './blockchain.service';
import { VaultInsertingService } from './vault-inserting.service';
import { BlockchainController } from './blockchain.controller';
import { AnvilApiService } from './anvil-api.service';
import { WebhookVerificationService } from './webhook-verification.service';
import { VaultManagingService } from './vault-managing.service';
import { TransactionsModule } from '../transactions/transactions.module';
import { BlockchainScannerService } from './blockchain-scanner.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Vault } from '../../database/vault.entity';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    HttpModule,
    TransactionsModule,
    TypeOrmModule.forFeature([
      Vault,
    ])
  ],
  controllers: [BlockchainController],
  providers: [
    BlockchainService,
    VaultInsertingService,
    AnvilApiService,
    BlockchainScannerService,
    WebhookVerificationService,
    VaultManagingService
  ],
  exports: [
    BlockchainService,
    VaultInsertingService,
    WebhookVerificationService,
    VaultManagingService,
    BlockchainScannerService
  ]
})
export class BlockchainModule {}
