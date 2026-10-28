import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export const SUPPORT_MESSAGE_MAX_LENGTH = 2000;

export class CreateSupportRequestReq {
  @ApiProperty({ description: 'Where the team should reply' })
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({ minLength: 10, maxLength: SUPPORT_MESSAGE_MAX_LENGTH })
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(SUPPORT_MESSAGE_MAX_LENGTH)
  message: string;

  @ApiPropertyOptional({ description: 'Connected wallet address (unverified unless the request is authenticated)' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  walletAddress?: string;

  @ApiPropertyOptional({ enum: ['cardano', 'robinhood'] })
  @IsOptional()
  @IsIn(['cardano', 'robinhood'])
  chain?: 'cardano' | 'robinhood';

  @ApiPropertyOptional({ description: 'App page the user wrote from' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  pageUrl?: string;

  @ApiPropertyOptional({ description: 'Honeypot — left empty by humans, filled in by bots' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  website?: string;
}
