import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

import { Transaction } from '@/database/transaction.entity';

export class GetInvestmentTransactionsRes {
  @Expose()
  @ApiProperty({ description: 'List of investment transactions', type: [Transaction] })
  transactions: Transaction[];
}
