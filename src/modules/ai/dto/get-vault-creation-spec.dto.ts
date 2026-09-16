import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsIn } from 'class-validator';

import { ChainType, VAULT_CREATION_CHAIN_TYPES } from '@/types/vault.types';

export class GetVaultCreationSpecDto {
  @ApiProperty({ enum: VAULT_CREATION_CHAIN_TYPES })
  @IsIn(VAULT_CREATION_CHAIN_TYPES)
  @Expose()
  chain: ChainType;

  @ApiProperty({ enum: ['preprod', 'mainnet'] })
  @IsIn(['preprod', 'mainnet'])
  @Expose()
  network: 'preprod' | 'mainnet';
}
