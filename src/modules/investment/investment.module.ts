import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InvestmentController } from './investment.controller';
import { InvestmentService } from './investment.service';
import {Vault} from '../../database/vault.entity';
import {User} from '../../database/user.entity';
import {TransactionsModule} from '../transactions/transactions.module';

@Module({
  imports: [TypeOrmModule.forFeature([Vault, User]), TransactionsModule],
  controllers: [InvestmentController],
  providers: [InvestmentService],
  exports: [InvestmentService],
})
export class InvestmentModule {}
