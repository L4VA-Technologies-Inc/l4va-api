import { IsOptional } from 'class-validator';

import { TransactionStatus, TransactionType } from '@/types/transaction.types';

export class GetTransactionsDto {
  @IsOptional()
  page?: string;

  @IsOptional()
  limit?: string;

  @IsOptional()
  filter?: TransactionType;

  @IsOptional()
  status?: TransactionStatus;

  @IsOptional()
  order?: 'ASC' | 'DESC';

  @IsOptional()
  period?: {
    from?: string;
    to?: string;
  };
}
