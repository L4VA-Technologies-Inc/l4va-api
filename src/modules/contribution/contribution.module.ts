import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContributionController } from './contribution.controller';
import { ContributionService } from './contribution.service';
import {Vault} from '../../database/vault.entity';
import {TransactionsModule} from '../transactions/transactions.module';
import {User} from '../../database/user.entity';
import {Asset} from '../../database/asset.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Vault, User, Asset]), TransactionsModule],
  controllers: [ContributionController],
  providers: [ContributionService],
  exports: [ContributionService],
})
export class ContributionModule {}
