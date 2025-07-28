import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';

import { TransactionStatus, TransactionType } from '@/types/transaction.types';

class VaultBasicInfoDto {
  @ApiProperty({ description: 'Vault name' })
  @Expose()
  name: string;

  @ApiProperty({ description: 'Vault description' })
  @Expose()
  description: string;
}

export class WaitingTransactionsResponseDto {
  @ApiProperty({ description: 'Transaction unique identifier' })
  @Expose()
  id: string;

  @ApiPropertyOptional({ description: 'Input UTXO' })
  @Expose()
  utxo_input?: string | null;

  @ApiPropertyOptional({ description: 'Output UTXO' })
  @Expose()
  utxo_output?: string | null;

  @ApiPropertyOptional({ description: 'Reference UTXO' })
  @Expose()
  utxo_ref?: string | null;

  @ApiProperty({ enum: TransactionType, description: 'Transaction type' })
  @Expose()
  type: TransactionType;

  @ApiPropertyOptional({ description: 'Transaction amount' })
  @Expose()
  amount?: number | null;

  @ApiPropertyOptional({ description: 'Transaction fee' })
  @Expose()
  fee?: number | null;

  @ApiProperty({ description: 'Transaction hash' })
  @Expose()
  tx_hash: string;

  @ApiProperty({ enum: TransactionStatus, description: 'Transaction status' })
  @Expose()
  status: TransactionStatus;

  @ApiProperty({ description: 'Associated vault ID' })
  @Expose()
  vault_id: string;

  @ApiProperty({ description: 'User ID who initiated the transaction' })
  @Expose()
  user_id: string;

  @ApiPropertyOptional({ description: 'Creation date' })
  @Expose()
  created_at?: Date;

  @ApiPropertyOptional({ description: 'Last update date' })
  @Expose()
  updated_at?: Date;

  @ApiProperty({ type: () => VaultBasicInfoDto, description: 'Vault information' })
  @Expose()
  @Type(() => VaultBasicInfoDto)
  vault: VaultBasicInfoDto;
}
