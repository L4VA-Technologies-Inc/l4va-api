import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsString, IsNumber, IsOptional, Matches } from 'class-validator';

export class AssetWhitelistDto {
  @ApiProperty({
    description: 'Policy ID of the asset (56-character hex string)',
    example: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd',
  })
  @IsString()
  @Matches(/^[0-9a-fA-F]{56}$/, {
    message: 'Policy ID must be a 56-character hexadecimal string',
  })
  policyId: string;

  @ApiProperty({
    description: 'Minimum number of assets allowed',
    required: false,
    example: 1,
  })
  @IsOptional()
  @IsNumber()
  @Expose({ name: 'countCapMin' })
  countCapMin?: number;

  @ApiProperty({
    description: 'Maximum number of assets allowed',
    required: false,
    example: 10,
  })
  @IsOptional()
  @IsNumber()
  @Expose({ name: 'countCapMax' })
  countCapMax?: number;

  @ApiProperty({
    description: 'Unique ID for the asset',
    required: false,
    example: 1456431,
  })
  @IsOptional()
  @IsNumber()
  uniqueId?: number;
}
