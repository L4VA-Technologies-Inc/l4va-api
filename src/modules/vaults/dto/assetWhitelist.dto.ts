import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNumber, IsOptional, Matches } from 'class-validator';
import { Expose } from 'class-transformer';

export class AssetWhitelistDto {
  @ApiProperty({
    description: 'Policy ID of the asset (56-character hex string)',
    example: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd'
  })
  @IsString()
  @Matches(/^[0-9a-fA-F]{56}$/, {
    message: 'Policy ID must be a 56-character hexadecimal string'
  })
  id: string;

  @ApiProperty({
    description: 'Minimum number of assets allowed',
    required: false,
    example: 1
  })
  @IsOptional()
  @IsNumber()
  @Expose({ name: 'assetCountCapMin' })
  countCapMin?: number;

  @ApiProperty({
    description: 'Maximum number of assets allowed',
    required: false,
    example: 10
  })
  @IsOptional()
  @IsNumber()
  @Expose({ name: 'assetCountCapMax' })
  countCapMax?: number;
}
