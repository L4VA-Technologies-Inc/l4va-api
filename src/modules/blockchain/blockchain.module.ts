import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BlockchainService } from './blockchain.service';
import { BlockchainTransactionService } from './blockchain-transaction.service';
import { BlockchainController } from './blockchain.controller';
import { AnvilApiService } from './anvil-api.service';
import { WebhookVerificationService } from './webhook-verification.service';
import { VaultContractService } from './vault-contract.service';
import { TransactionsModule } from '../transactions/transactions.module';
import {BlockchainScannerService} from './blockchain-scanner.service';
import {TypeOrmModule} from '@nestjs/typeorm';
import {Vault} from '../../database/vault.entity';

@Module({
  imports: [ConfigModule, TransactionsModule,
    TypeOrmModule.forFeature([
        Vault,])
  ],
  controllers: [BlockchainController],
  providers: [
    BlockchainService,
    BlockchainTransactionService,
    AnvilApiService,
    BlockchainScannerService,
    WebhookVerificationService,
    VaultContractService
  ],
  exports: [
    BlockchainService,
    BlockchainTransactionService,
    WebhookVerificationService,
    VaultContractService,
    BlockchainScannerService
  ]
})
export class BlockchainModule {}
