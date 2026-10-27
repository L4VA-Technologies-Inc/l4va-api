import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsEnum, IsOptional } from 'class-validator';

import { ChainType } from '@/types/vault.types';

export class GetVaultStatisticsQuery {
  @IsEnum(ChainType)
  @IsOptional()
  @ApiProperty({
    enum: ChainType,
    required: false,
    description: 'Filter statistics by chain type (cardano or robinhood)',
  })
  @Expose()
  chainType?: ChainType;
}
