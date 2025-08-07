import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, IsString, IsOptional, IsBoolean, ValidateNested } from 'class-validator';

export class TokenInfo {
  @ApiProperty({
    description: 'Policy ID of the token (leave empty for ADA)',
    required: false,
  })
  @IsOptional()
  @IsString()
  policyId?: string;

  @ApiProperty({ description: 'Asset name of the token (hex format, leave empty for ADA)' })
  @IsString()
  assetName: string;

  @ApiProperty({ description: 'Amount of the token in smallest unit' })
  @IsNumber()
  amount: number;
}

export class CreatePoolDto {
  @ApiProperty({ description: 'Network ID (1 for mainnet, 0 for testnet)' })
  networkId: number;

  @ApiProperty({ description: 'Token A information' })
  @ValidateNested()
  @Type(() => TokenInfo)
  tokenA: TokenInfo;

  @ApiProperty({ description: 'Token B information' })
  @ValidateNested()
  @Type(() => TokenInfo)
  tokenB: TokenInfo;

  @ApiProperty({ description: 'Whether to use VyFi v2', required: false, default: true })
  @IsOptional()
  @IsBoolean()
  v2?: boolean;

  @ApiProperty({ description: 'Pool owner address', required: false })
  @IsOptional()
  @IsString()
  poolOwnerAddress?: string;

  @ApiProperty({ description: 'Pool factory address', required: false })
  @IsOptional()
  @IsString()
  poolFactoryAddress?: string;
}
