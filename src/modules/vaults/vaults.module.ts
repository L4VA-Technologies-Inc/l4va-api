import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VaultsService } from './vaults.service';
import { VaultsController } from './vaults.controller';
import { LifecycleModule } from '../lifecycle/lifecycle.module';
import { Vault } from '../../database/vault.entity';
import {User} from '../../database/user.entity';
import {FileEntity} from '../../database/file.entity';
import {AssetsWhitelistEntity} from '../../database/assetsWhitelist.entity';
import {LinkEntity} from '../../database/link.entity';
import {InvestorsWhitelistEntity} from '../../database/investorsWhitelist.entity';
import {AwsModule} from '../aws_bucket/aws.module';
import {TagEntity} from '../../database/tag.entity';
import { DraftVaultsService } from './draft-vaults.service';
import {ContributorWhitelistEntity} from '../../database/contributorWhitelist.entity';
import {TransactionsModule} from '../transactions/transactions.module';
import {BlockchainModule} from '../blockchain/blockchain.module';

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
      AssetsWhitelistEntity,
      LinkEntity, InvestorsWhitelistEntity, TagEntity, ContributorWhitelistEntity]),
  ],
  providers: [VaultsService, DraftVaultsService],
  controllers: [VaultsController],
  exports: [VaultsService, DraftVaultsService],
})
export class VaultsModule {}
