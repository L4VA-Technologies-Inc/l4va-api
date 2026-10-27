import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsOptional, IsString, IsNotEmpty } from 'class-validator';

import { ChainType } from '@/types/vault.types';

export class PublishVaultDto {
  @ApiProperty({ description: 'Vault ID', example: '83a400...' })
  @IsString()
  @IsNotEmpty()
  @Expose()
  vaultId: string;

  @ApiProperty({ description: 'CBOR encoded transaction', example: '83a400...', required: false })
  @IsOptional()
  @IsString()
  @Expose()
  transaction?: string;

  @ApiProperty({ description: 'Array of CBOR encoded signatures', example: ['84a400...'], required: false })
  @IsOptional()
  @IsString({ each: true })
  @Expose()
  signatures?: string[];

  @ApiProperty({ description: 'Internal transaction record ID (Cardano)', required: false })
  @IsOptional()
  @IsString()
  @Expose()
  txId?: string;

  @ApiProperty({ description: 'EVM on-chain tx hash (Robinhood)', required: false })
  @IsOptional()
  @IsString()
  @Expose()
  txHash?: string;

  @ApiProperty({ description: 'Chain type — determines which publish flow to use', enum: ChainType, required: false })
  @IsOptional()
  @Expose()
  chainType?: ChainType;
}
