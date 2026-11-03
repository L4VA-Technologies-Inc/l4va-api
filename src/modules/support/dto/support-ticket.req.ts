import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export const SUPPORT_MESSAGE_MAX_LENGTH = 2000;

export class SendSupportMessageReq {
  @ApiProperty({ maxLength: SUPPORT_MESSAGE_MAX_LENGTH })
  @IsString()
  @IsNotEmpty()
  @MaxLength(SUPPORT_MESSAGE_MAX_LENGTH)
  message: string;
}

export class OpenSupportTicketReq extends SendSupportMessageReq {
  @ApiPropertyOptional({ enum: ['cardano', 'robinhood'] })
  @IsOptional()
  @IsIn(['cardano', 'robinhood'])
  chain?: 'cardano' | 'robinhood';

  @ApiPropertyOptional({ description: 'App page the user wrote from' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  pageUrl?: string;
}
