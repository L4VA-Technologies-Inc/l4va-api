import { Expose, Type } from 'class-transformer';

import { TransactionStatus } from '@/types/transaction.types';

export class TransactionsResponseDto {
  @Expose()
  page: number;

  @Expose()
  limit: number;

  @Expose()
  total: number;

  @Expose()
  items: TransactionsResponseItemsDto[];
}

export class TransactionsVaultDto {
  @Expose()
  id: string;

  @Expose()
  name: string;
}

export class TransactionsResponseItemsDto {
  @Expose()
  id: string;

  @Expose()
  type?: string;

  @Expose()
  status?: TransactionStatus;

  @Expose()
  amount: string;

  @Expose()
  metadata: Record<string, any> | null;

  @Expose()
  tx_hash: string;

  @Expose()
  updated_at: string;

  @Expose()
  created_at: string;

  @Expose()
  @Type(() => TransactionsVaultDto)
  vault?: TransactionsVaultDto;
}
