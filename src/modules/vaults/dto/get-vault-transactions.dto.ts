import { IsEnum, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { TransactionStatus, TransactionType } from '../../../types/transaction.types';
import {Expose} from "class-transformer";

export class GetVaultTransactionsDto {
  @ApiProperty({
    enum: TransactionStatus,
    description: 'Filter transactions by status',
    required: false,
    default: TransactionStatus.confirmed
  })
  @IsOptional()
  @IsEnum(TransactionStatus)
  @Expose()
  status?: TransactionStatus = TransactionStatus.confirmed;

  @ApiProperty({
    enum: [TransactionType.contribute, TransactionType.investment],
    description: 'Filter transactions by type (contribute or investment)',
    required: false
  })
  @IsOptional()
  @IsEnum(TransactionType)
  @Expose()
  type?: TransactionType;
}
