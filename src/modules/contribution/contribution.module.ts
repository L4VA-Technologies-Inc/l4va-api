import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContributionController } from './contribution.controller';
import { ContributionService } from './contribution.service';
import {Vault} from '../../database/vault.entity';
import {TransactionsModule} from '../transactions/transactions.module';

@Module({
  imports: [TypeOrmModule.forFeature([Vault]), TransactionsModule],
  controllers: [ContributionController],
  providers: [ContributionService],
  exports: [ContributionService],
})
export class ContributionModule {}
