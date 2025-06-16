import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AcquirerWhitelistEntity } from 'src/database/acquirerWhitelist.entity';
import { Asset } from 'src/database/asset.entity';
import { AssetsWhitelistEntity } from 'src/database/assetsWhitelist.entity';
import { ContributorWhitelistEntity } from 'src/database/contributorWhitelist.entity';
import { FileEntity } from 'src/database/file.entity';
import { LinkEntity } from 'src/database/link.entity';
import { TagEntity } from 'src/database/tag.entity';
import { User } from 'src/database/user.entity';
import { Vault } from 'src/database/vault.entity';
import { AwsModule } from '../aws_bucket/aws.module';

import { DraftVaultsService } from './draft-vaults.service';
import { LifecycleModule } from './phase-management/lifecycle/lifecycle.module';
import { TransactionsModule } from './processing-tx/offchain-tx/transactions.module';
import { BlockchainModule } from './processing-tx/onchain/blockchain.module';
import { VaultsController } from './vaults.controller';
import { VaultsService } from './vaults.service';

@Module({
  imports: [
    AwsModule,
    LifecycleModule,
    TransactionsModule,
    BlockchainModule,
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
