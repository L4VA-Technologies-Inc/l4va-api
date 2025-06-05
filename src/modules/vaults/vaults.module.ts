import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VaultsService } from './vaults.service';
import { VaultsController } from './vaults.controller';
import { LifecycleModule } from './phase-management/lifecycle/lifecycle.module';
import { Vault } from '../../database/vault.entity';
import {User} from '../../database/user.entity';
import {FileEntity} from '../../database/file.entity';
import {AssetsWhitelistEntity} from '../../database/assetsWhitelist.entity';
import {LinkEntity} from '../../database/link.entity';
import {AcquirerWhitelistEntity} from '../../database/acquirerWhitelist.entity';
import {AwsModule} from '../aws_bucket/aws.module';
import {TagEntity} from '../../database/tag.entity';
import { DraftVaultsService } from './draft-vaults.service';
import {ContributorWhitelistEntity} from '../../database/contributorWhitelist.entity';
import {TransactionsModule} from './processing-tx/offchain-tx/transactions.module';
import {BlockchainModule} from './processing-tx/onchain/blockchain.module';
import {Asset} from "../../database/asset.entity";
import {TaptoolsModule} from "../taptools/taptools.module";

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
      LinkEntity, AcquirerWhitelistEntity, TagEntity, ContributorWhitelistEntity]),
  ],
  providers: [VaultsService, DraftVaultsService],
  controllers: [VaultsController],
  exports: [VaultsService, DraftVaultsService],
})
export class VaultsModule {}
