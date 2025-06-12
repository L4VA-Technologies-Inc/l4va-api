import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsString, IsOptional, IsBoolean, IsObject } from 'class-validator';

export class TokenInfo {
  @ApiProperty({ description: 'Policy ID of the token' })
  @IsString()
  policyId: string;

  @ApiProperty({ description: 'Asset name of the token' })
  @IsString()
  assetName: string;

  @ApiProperty({ description: 'Amount of the token' })
  @IsNumber()
  amount: number;
}

export class CreatePoolDto {
  @ApiProperty({ description: 'Network ID (1 for mainnet, 0 for testnet)' })
  @IsNumber()
  networkId: number;

  @ApiProperty({ description: 'Token A information' })
  @IsObject()
  tokenA: TokenInfo;

  @ApiProperty({ description: 'Token B information' })
  @IsObject()
  tokenB: TokenInfo;

  @ApiProperty({ description: 'Whether to use VyFi v2', required: false, default: true })
  @IsOptional()
  @IsBoolean()
  v2?: boolean;

  @ApiProperty({ description: 'Pool owner address' })
  @IsString()
  poolOwnerAddress: string;

  @ApiProperty({ description: 'Pool factory address' })
  @IsString()
  poolFactoryAddress: string;
}
