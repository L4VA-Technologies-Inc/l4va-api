import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsString, IsOptional } from 'class-validator';

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
