import { IsOptional } from 'class-validator';

import { TransactionStatus } from '@/types/transaction.types';

export class GetTransactionsDto {
  @IsOptional()
  page?: string;

  @IsOptional()
  limit?: string;

  @IsOptional()
  filter?: GetTransactionType;

  @IsOptional()
  status?: TransactionStatus;

  @IsOptional()
  order?: 'ASC' | 'DESC';

  @IsOptional()
  period?: {
    from?: string;
    to?: string;
  };

  @IsOptional()
  isExport?: boolean;
}

export enum GetTransactionType {
  createVault = 'create-vault',
  mint = 'mint',
  payment = 'payment',
  contribute = 'contribute', // Contains NFTs
  claim = 'claim',
  extract = 'extract',
  extractDispatch = 'extract-dispatch',
  cancel = 'cancel',
  acquire = 'acquire', // Contains only lovelace (ADA)
  investment = 'investment',
  burn = 'burn',
  swap = 'swap',
  stake = 'stake',
  extractLp = 'extract-lp',
  distributeLp = 'distribute-lp',
  updateVault = 'update-vault', // Vault metadata update transaction
  all = 'all',
  distribution = 'distribution',
}
