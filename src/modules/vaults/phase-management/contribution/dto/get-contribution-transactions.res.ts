import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

import { Transaction } from '@/database/transaction.entity';

export class GetContributionTransactionsRes {
  @Expose()
  @ApiProperty({ description: 'List of contribution transactions', type: [Transaction] })
  transactions: Transaction[];
}
