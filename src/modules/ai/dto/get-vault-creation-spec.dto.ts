import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsEnum, IsIn } from 'class-validator';

import { ChainType } from '@/types/vault.types';

export class GetVaultCreationSpecDto {
  @ApiProperty({ enum: [ChainType.cardano, ChainType.robinhood] })
  @IsEnum(ChainType)
  @Expose()
  chain: ChainType;

  @ApiProperty({ enum: ['preprod', 'mainnet'] })
  @IsIn(['preprod', 'mainnet'])
  @Expose()
  network: 'preprod' | 'mainnet';
}
