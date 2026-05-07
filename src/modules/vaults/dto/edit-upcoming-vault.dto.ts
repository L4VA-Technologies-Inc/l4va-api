import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { SocialLink } from '../types';

export class EditUpcomingVaultDto {
  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  @MaxLength(500)
  description: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  tokenDescription?: string;

  @ApiProperty({ minimum: 0, maximum: 100, type: Number })
  @IsNumber()
  @Type(() => Number)
  @Min(0)
  @Max(100)
  tokensForAcquires: number;

  @ApiProperty({ minimum: 0, maximum: 100, type: Number })
  @IsNumber()
  @Type(() => Number)
  @Min(0)
  @Max(100)
  acquireReserve: number;

  @ApiProperty({ minimum: 0, maximum: 100, type: Number })
  @IsNumber()
  @Type(() => Number)
  @Min(0)
  @Max(100)
  liquidityPoolContribution: number;

  @ApiProperty({ minimum: 0, maximum: 100, type: Number })
  @IsNumber()
  @Type(() => Number)
  @Min(0)
  @Max(100)
  creationThreshold: number;

  @ApiProperty({ minimum: 0, maximum: 100, type: Number })
  @IsNumber()
  @Type(() => Number)
  @Min(0)
  @Max(100)
  cosigningThreshold: number;

  @ApiProperty({ minimum: 0, maximum: 100, type: Number })
  @IsNumber()
  @Type(() => Number)
  @Min(0)
  @Max(100)
  executionThreshold: number;

  @ApiProperty({ type: [SocialLink] })
  @IsArray()
  @Type(() => SocialLink)
  @ValidateNested({ each: true })
  socialLinks: SocialLink[];

  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  tags: string[];

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  vaultImage: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  ftTokenImg: string;

  @ApiProperty({ minLength: 1, maxLength: 9 })
  @IsNotEmpty()
  @IsString()
  @MinLength(1)
  @MaxLength(9)
  vaultTokenTicker: string;
}
