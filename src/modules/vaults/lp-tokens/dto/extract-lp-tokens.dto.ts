import { IsNotEmpty, IsString, IsNumber, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import {Expose} from "class-transformer";

export class ExtractLpTokensDto {
  @ApiProperty({ description: 'The ID of the vault to extract tokens from' })
  @IsString()
  @IsNotEmpty()
  @Expose()
  vaultId: string;

  @ApiProperty({ description: 'The wallet address to send the LP tokens to' })
  @IsString()
  @IsNotEmpty()
  @Expose()
  walletAddress: string;

  @ApiProperty({ description: 'The amount of LP tokens to extract' })
  @IsNumber()
  @IsNotEmpty()
  @Expose()
  amount: number;

  @ApiProperty({
    description: 'Transaction hash (optional)',
    required: false
  })
  @IsString()
  @IsOptional()
  @Expose()
  txHash?: string;

  @ApiProperty({
    description: 'Transaction index (optional)',
    required: false,
    type: Number
  })
  @IsNumber()
  @IsOptional()
  @Expose()
  txIndex?: number;
}
