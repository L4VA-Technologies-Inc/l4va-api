import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsEnum, IsOptional } from 'class-validator';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

export class GetVaultTransactionsDto {
  @ApiProperty({
    enum: TransactionStatus,
    description: 'Filter transactions by status',
    required: false,
    default: TransactionStatus.confirmed,
  })
  @IsOptional()
  @IsEnum(TransactionStatus)
  @Expose()
  status?: TransactionStatus = TransactionStatus.confirmed;

  @ApiProperty({
    enum: [TransactionType.contribute, TransactionType.acquire],
    description: 'Filter transactions by type (contribute or acquire)',
    required: false,
  })
  @IsOptional()
  @IsEnum(TransactionType)
  @Expose()
  type?: TransactionType;
}
