import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class PublishVaultDto {
  @ApiProperty({
    description: 'Vault ID',
    example: '83a400...',
  })
  @IsString()
  @IsNotEmpty()
  @Expose()
  vaultId: string;

  @ApiProperty({
    description: 'CBOR encoded transaction',
    example: '83a400...',
  })
  @IsString()
  @Expose()
  transaction: string;

  @ApiProperty({
    description: 'Array of CBOR  encoded signatures',
    example: ['84a400...'],
    required: false,
  })
  @IsOptional()
  @IsString({ each: true })
  @Expose()
  signatures?: string[];

  @ApiProperty({
    description: 'Outchain transaction ID (optional) ',
    example: '123e4567-e89b-12d3-a456-426614174000',
    required: false,
  })
  @IsOptional()
  @IsString()
  @Expose()
  txId?: string;
}
