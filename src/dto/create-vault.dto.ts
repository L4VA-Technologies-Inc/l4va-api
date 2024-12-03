import { ApiProperty } from '@nestjs/swagger';

export class CreateVaultDto {
  @ApiProperty({ description: 'Smart contract address of the vault' })
  contractAddress: string;

  @ApiProperty({
    description: 'Type of the vault',
    enum: ['PRIVATE', 'PUBLIC', 'SEMI_PRIVATE'],
  })
  type: 'PRIVATE' | 'PUBLIC' | 'SEMI_PRIVATE';

  @ApiProperty({
    description: 'Status of the vault',
    enum: ['DRAFT', 'ACTIVE', 'LOCKED', 'TERMINATED'],
  })
  status: 'DRAFT' | 'ACTIVE' | 'LOCKED' | 'TERMINATED';

  @ApiProperty({
    description: 'Token contract address for fractionalization',
    required: false,
  })
  fractionalizationTokenAddress?: string;

  @ApiProperty({ description: 'Fractionalization percentage', required: false })
  fractionalizationPercentage?: number;

  @ApiProperty({
    description: 'Token supply for fractionalization',
    required: false,
  })
  tokenSupply?: number;

  @ApiProperty({
    description: 'Decimals for the fractional token',
    required: false,
  })
  tokenDecimals?: number;

  @ApiProperty({
    description: 'Additional metadata as a JSON string',
    required: false,
  })
  metadata?: string;
}
