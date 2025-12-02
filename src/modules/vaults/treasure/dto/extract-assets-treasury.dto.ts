import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class ExtractAssetsToTreasuryDto {
  @ApiProperty({
    description: 'UUID of the vault to extract assets from',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  @IsNotEmpty()
  vaultId: string;

  @ApiProperty({
    description: 'Array of asset IDs to extract from the vault',
    example: ['asset-uuid-1', 'asset-uuid-2'],
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty()
  assetIds: string[];

  @ApiPropertyOptional({
    description: 'Optional treasury address to send assets to. Defaults to admin address if not provided.',
    example: 'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x',
  })
  @IsOptional()
  @IsString()
  treasuryAddress?: string;
}

export class ExtractAllVaultAssetsDto {
  @ApiProperty({
    description: 'UUID of the vault to extract all assets from',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  @IsNotEmpty()
  vaultId: string;

  @ApiPropertyOptional({
    description: 'Optional treasury address to send assets to. Defaults to admin address if not provided.',
    example: 'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x',
  })
  @IsOptional()
  @IsString()
  treasuryAddress?: string;
}

export class ExtractionStatusDto {
  @ApiProperty({
    description: 'UUID of the vault to check extraction status',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  @IsNotEmpty()
  vaultId: string;
}
