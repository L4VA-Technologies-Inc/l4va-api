import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsInt, Min, Max, IsUrl } from 'class-validator';

export class TokenMetadataDto {
  @ApiProperty({
    description: 'Vault ID',
    example: '084748e6-fc7c-4f9f-90a7-dad3efd58522',
  })
  @IsString()
  @IsNotEmpty()
  vaultId: string;

  @ApiProperty({
    description: 'Token subject (policyId + assetName in hex)',
    example:
      '2bd0c232f221b65b28a5ca0fce1adbefac04c43cb75ddbc2b2cb0f1b3505a6451ddd073c51fd04b2094d6abeaa7fc338eb9bc28a9ec67e1eaf935939',
  })
  @IsString()
  @IsNotEmpty()
  subject: string;

  @ApiProperty({
    description: 'Token name',
    example: 'The GOAT',
    minLength: 1,
    maxLength: 50,
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    description: 'Token description',
    example: 'A vault token representing ownership in The GOAT vault',
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

  @ApiProperty({
    description: 'Token ticker symbol',
    example: 'GOAT',
    minLength: 1,
    maxLength: 9,
  })
  @IsString()
  @IsNotEmpty()
  ticker: string;

  @ApiPropertyOptional({
    description: 'Token website URL',
    example: 'https://l4va.io',
  })
  @IsOptional()
  @IsUrl({}, { message: 'URL must be a valid HTTPS URL' })
  url?: string;

  @ApiPropertyOptional({
    description: 'Token logo URL or base64 encoded image',
    example: 'https://example.com/logo.png',
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
