import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { TransactionStatus } from '@/types/transaction.types';

export class StakeTransactionItemRes {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiPropertyOptional({ description: 'On-chain transaction hash' })
  tx_hash?: string;

  @ApiProperty({ enum: TransactionStatus })
  status: TransactionStatus;

  @ApiPropertyOptional({ description: 'Staked token amount when known' })
  amount?: number;

  @ApiPropertyOptional({ description: 'Policy id, ticker, contract address, etc.' })
  metadata?: Record<string, unknown> | null;

  @ApiPropertyOptional({ description: 'User payment address (sender)' })
  utxo_input?: string;

  @ApiPropertyOptional({ description: 'Contract / receiver' })
  utxo_output?: string;

  @ApiProperty()
  created_at: Date;

  @ApiProperty()
  updated_at: Date;
}
