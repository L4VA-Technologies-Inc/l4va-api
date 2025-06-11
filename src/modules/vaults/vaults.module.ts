import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AcquirerWhitelistEntity } from '../../database/acquirerWhitelist.entity';
import { DraftVaultsService } from './draft-vaults.service';
import {ContributorWhitelistEntity} from '../../database/contributorWhitelist.entity';
import {TransactionsModule} from '../transactions/transactions.module';
import {BlockchainModule} from '../blockchain/blockchain.module';
import {Asset} from "../../database/asset.entity";
import {AssetsWhitelistEntity} from '../../database/assetsWhitelist.entity';
import { FileEntity } from '../../database/file.entity';
import {LinkEntity} from '../../database/link.entity';
import {TagEntity} from '../../database/tag.entity';
import { User } from '../../database/user.entity';
import { Vault } from '../../database/vault.entity';
import { AwsModule } from '../aws_bucket/aws.module';
import { LifecycleModule } from '../lifecycle/lifecycle.module';
import { TaptoolsModule } from '../taptools/taptools.module';

import { VaultsController } from './vaults.controller';
import { VaultsService } from './vaults.service';

@Module({
  imports: [
    TaptoolsModule,
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
