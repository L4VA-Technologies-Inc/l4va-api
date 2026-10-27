import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsInt, Min, Max, IsUrl } from 'class-validator';

// One-off endpoint for submitting a token that is NOT backed by a vault
// (e.g. the standalone L4VA token). Unlike TokenMetadataDto this has no
// vaultId, and the resulting PR is not tracked in the token_registry table.
export class SubmitStandaloneTokenMetadataDto {
  @ApiProperty({
    description: 'Token subject (policyId + assetName in hex)',
    example:
      '2bd0c232f221b65b28a5ca0fce1adbefac04c43cb75ddbc2b2cb0f1b3505a6451ddd073c51fd04b2094d6abeaa7fc338eb9bc28a9ec67e1eaf935939',
  })
  @IsString()
  @IsNotEmpty()
  subject: string;

  @ApiProperty({ description: 'Token name', example: 'L4VA', minLength: 1, maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    description: 'Token description',
    example: 'The L4VA token',
    minLength: 1,
    maxLength: 500,
  })
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiPropertyOptional({
    description: 'Base16-encoded CBOR representation of the monetary policy script',
    example: '82018201828200581cf950845fdf374bba64605f96a9d5940890cc2bb92c4b5b55139cc00982051a09bde472',
  })
  @IsOptional()
  @IsString()
  policy?: string;

  @ApiProperty({ description: 'Token ticker symbol', example: 'L4VA', minLength: 1, maxLength: 9 })
  @IsString()
  @IsNotEmpty()
  ticker: string;

  @ApiProperty({ description: 'Token website URL', example: 'https://l4va.io' })
  @IsString()
  @IsNotEmpty()
  @IsUrl({}, { message: 'URL must be a valid HTTPS URL' })
  url: string;

  @ApiPropertyOptional({
    description: 'Token logo as a base64-encoded PNG byte string, or a URL to fetch/convert it from',
    example: 'iVBORw0KGgoAAAANSUhEUgAA...',
  })
  @IsOptional()
  @IsString()
  logo?: string;

  @ApiPropertyOptional({
    description: 'Number of decimal places for the token',
    example: 6,
    minimum: 0,
    maximum: 19,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(19)
  decimals?: number;
}
