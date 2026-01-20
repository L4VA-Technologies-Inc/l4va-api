import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AssetsModule } from '../../assets/assets.module';
import { TransactionsModule } from '../offchain-tx/transactions.module';

import { BlockchainWebhookService } from './blockchain-webhook.service';
import { BlockchainController } from './blockchain.controller';
import { BlockchainService } from './blockchain.service';
import { MetadataRegistryApiService } from './metadata-register.service';
import { VaultContributionService } from './vault-contribution.service';
import { VaultManagingService } from './vault-managing.service';

import { Asset } from '@/database/asset.entity';
import { AssetsWhitelistEntity } from '@/database/assetsWhitelist.entity';
import { Claim } from '@/database/claim.entity';
import { TokenRegistry } from '@/database/tokenRegistry.entity';
import { Transaction } from '@/database/transaction.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    HttpModule,
    TransactionsModule,
    AssetsModule,
    TypeOrmModule.forFeature([Vault, Transaction, AssetsWhitelistEntity, TokenRegistry, Asset, Claim, User]),
  ],
  controllers: [BlockchainController],
  providers: [
    MetadataRegistryApiService,
    BlockchainService,
    VaultContributionService,
    BlockchainWebhookService,
    VaultManagingService,
  ],
  exports: [
    BlockchainService,
    VaultContributionService,
    BlockchainWebhookService,
    VaultManagingService,
    MetadataRegistryApiService,
  ],
})
export class BlockchainModule {}
