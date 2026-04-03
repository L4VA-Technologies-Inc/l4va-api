import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DexHunterModule } from '../dexhunter/dexhunter.module';
import { GoogleCloudStorageModule } from '../google_cloud/google_bucket/bucket.module';
import { TaptoolsModule } from '../taptools/taptools.module';
import { WayUpPricingModule } from '../wayup/wayup-pricing.module';

import { DraftVaultsService } from './draft-vaults.service';
import { TokenVerificationRefreshService } from './token-verification-refresh.service';
import { VaultFilesCleanupService } from './vault-files-cleanup.service';
import { VaultsController } from './vaults.controller';
import { VaultsService } from './vaults.service';

import { AcquirerWhitelistEntity } from '@/database/acquirerWhitelist.entity';
import { Asset } from '@/database/asset.entity';
import { AssetsWhitelistEntity } from '@/database/assetsWhitelist.entity';
import { ContributorWhitelistEntity } from '@/database/contributorWhitelist.entity';
import { FileEntity } from '@/database/file.entity';
import { LinkEntity } from '@/database/link.entity';
import { Proposal } from '@/database/proposal.entity';
import { Snapshot } from '@/database/snapshot.entity';
import { TagEntity } from '@/database/tag.entity';
import { TokenVerification } from '@/database/token-verification.entity';
import { Transaction } from '@/database/transaction.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { DistributionModule } from '@/modules/distribution/distribution.module';
import { MarketStatsModule } from '@/modules/vaults/market-stats/market-stats.module';
import { GovernanceModule } from '@/modules/vaults/phase-management/governance/governance.module';
import { LifecycleModule } from '@/modules/vaults/phase-management/lifecycle/lifecycle.module';
import { TransactionsModule } from '@/modules/vaults/processing-tx/offchain-tx/transactions.module';
import { BlockchainModule } from '@/modules/vaults/processing-tx/onchain/blockchain.module';
import { StatisticsService } from '@/modules/vaults/statistics/statistics.service';

@Module({
  imports: [
    GoogleCloudStorageModule,
    LifecycleModule,
    TransactionsModule,
    BlockchainModule,
    GovernanceModule,
    DistributionModule,
    MarketStatsModule,
    TaptoolsModule,
    WayUpPricingModule,
    DexHunterModule,
    TypeOrmModule.forFeature([
      Vault,
      User,
      FileEntity,
      Asset,
      AssetsWhitelistEntity,
      LinkEntity,
      AcquirerWhitelistEntity,
      TagEntity,
      ContributorWhitelistEntity,
      Transaction,
      Proposal,
      Snapshot,
      TokenVerification,
    ]),
    HttpModule,
  ],
  providers: [
    VaultsService,
    DraftVaultsService,
    StatisticsService,
    VaultFilesCleanupService,
    TokenVerificationRefreshService,
  ],
  controllers: [VaultsController],
  exports: [VaultsService, DraftVaultsService],
})
export class VaultsModule {}
