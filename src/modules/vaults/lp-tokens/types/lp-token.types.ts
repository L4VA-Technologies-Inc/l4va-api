import { Transaction } from '../../../../database/transaction.entity';

export interface LpTokenOperationResult {
  success: boolean;
  transactionId?: string;
  transaction?: Transaction;
  message?: string;
  error?: any;
}

export interface ExtractLpTokensParams {
  vaultId: string;
  walletAddress: string;
  amount: number;
  txHash?: string;
  txIndex?: number;
}
