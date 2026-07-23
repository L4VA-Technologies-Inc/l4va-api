import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AssetsModule } from '../../assets/assets.module';
import { TransactionHealthService } from '../offchain-tx/transaction-health.service';
import { TransactionsModule } from '../offchain-tx/transactions.module';

import { BlockchainWebhookService } from './blockchain-webhook.service';
import { BlockchainController } from './blockchain.controller';
import { BlockchainService } from './blockchain.service';
import { EvmAdminSigner } from './evm-admin-signer.service';
import { EvmAllocationService } from './evm-allocation.service';
import { EvmContractReader } from './evm-contract-reader.service';
import { EvmCycleCloseService } from './evm-cycle-close.service';
import { EvmLockTimePricingService } from './evm-lock-time-pricing.service';
import { EvmVaultContributionService } from './evm-vault-contribution.service';
import { EvmVaultSignerService } from './evm-vault-signer.service';
import { EvmWebhookService } from './evm-webhook.service';
import { MetadataRegistryApiService } from './metadata-register.service';
import { VaultContributionService } from './vault-contribution.service';
import { VaultManagingService } from './vault-managing.service';

import { Asset } from '@/database/asset.entity';
import { AssetsWhitelistEntity } from '@/database/assetsWhitelist.entity';
import { Claim } from '@/database/claim.entity';
import { EvmAllocation } from '@/database/evm-allocation.entity';
import { EvmContributionValuation } from '@/database/evm-contribution-valuation.entity';
import { EvmContribution } from '@/database/evm-contribution.entity';
import { EvmValuationSnapshot } from '@/database/evm-valuation-snapshot.entity';
import { EvmAssetPriceFeedEntity } from '@/database/evmAssetPriceFeed.entity';
import { Proposal } from '@/database/proposal.entity';
import { TokenRegistry } from '@/database/tokenRegistry.entity';
import { Transaction } from '@/database/transaction.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { RewardsModule } from '@/modules/rewards/rewards.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    HttpModule,
    TransactionsModule,
    AssetsModule,
    RewardsModule,
    TypeOrmModule.forFeature([
      Vault,
      Transaction,
      AssetsWhitelistEntity,
      TokenRegistry,
      Asset,
      Claim,
      User,
      Proposal,
      EvmContribution,
      EvmValuationSnapshot,
      EvmContributionValuation,
      EvmAllocation,
      EvmAssetPriceFeedEntity,
    ]),
  ],
  controllers: [BlockchainController],
  providers: [
    MetadataRegistryApiService,
    BlockchainService,
    VaultContributionService,
    BlockchainWebhookService,
    EvmContractReader,
    EvmAdminSigner,
    EvmAllocationService,
    EvmLockTimePricingService,
    EvmCycleCloseService,
    EvmVaultSignerService,
    EvmVaultContributionService,
    EvmWebhookService,
    VaultManagingService,
    TransactionHealthService,
  ],
  exports: [
    BlockchainService,
    VaultContributionService,
    BlockchainWebhookService,
    VaultManagingService,
    MetadataRegistryApiService,
    TransactionHealthService,
    EvmContractReader,
    EvmAdminSigner,
    EvmAllocationService,
    EvmLockTimePricingService,
    EvmCycleCloseService,
  ],
})
export class BlockchainModule {}
