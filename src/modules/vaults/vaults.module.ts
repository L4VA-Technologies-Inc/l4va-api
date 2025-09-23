import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AwsModule } from '../aws_bucket/aws.module';

import { DraftVaultsService } from './draft-vaults.service';
import { VaultsController } from './vaults.controller';
import { VaultsService } from './vaults.service';

import { AcquirerWhitelistEntity } from '@/database/acquirerWhitelist.entity';
import { Asset } from '@/database/asset.entity';
import { AssetsWhitelistEntity } from '@/database/assetsWhitelist.entity';
import { ContributorWhitelistEntity } from '@/database/contributorWhitelist.entity';
import { FileEntity } from '@/database/file.entity';
import { LinkEntity } from '@/database/link.entity';
import { TagEntity } from '@/database/tag.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { GovernanceModule } from '@/modules/vaults/phase-management/governance/governance.module';
import { LifecycleModule } from '@/modules/vaults/phase-management/lifecycle/lifecycle.module';
import { TransactionsModule } from '@/modules/vaults/processing-tx/offchain-tx/transactions.module';
import { BlockchainModule } from '@/modules/vaults/processing-tx/onchain/blockchain.module';

@Module({
  imports: [
    AwsModule,
    LifecycleModule,
    TransactionsModule,
    BlockchainModule,
    GovernanceModule,
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
    ]),
  ],
  providers: [VaultsService, DraftVaultsService],
  controllers: [VaultsController],
  exports: [VaultsService, DraftVaultsService],
})
export class VaultsModule {}
