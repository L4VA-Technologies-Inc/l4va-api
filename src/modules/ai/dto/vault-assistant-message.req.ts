import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { ChainType } from '@/types/vault.types';

export const MAX_HISTORY_MESSAGES = 30;
export const MAX_MESSAGE_LENGTH = 4000;

export class AssistantChatMessage {
  @ApiProperty({ enum: ['user', 'assistant'] })
  @IsIn(['user', 'assistant'])
  @Expose()
  role: 'user' | 'assistant';

  @ApiProperty({ maxLength: MAX_MESSAGE_LENGTH })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_MESSAGE_LENGTH)
  @Expose()
  content: string;
}

export class VaultAssistantMessageReq {
  @ApiProperty({ type: [AssistantChatMessage], description: 'Conversation history, oldest first' })
  @IsArray()
  @ArrayMaxSize(MAX_HISTORY_MESSAGES)
  @ValidateNested({ each: true })
  @Type(() => AssistantChatMessage)
  @Expose()
  messages: AssistantChatMessage[];

  @ApiProperty({ enum: [ChainType.cardano, ChainType.robinhood] })
  @IsEnum(ChainType)
  @Expose()
  chain: ChainType;

  @ApiProperty({ enum: ['preprod', 'mainnet'] })
  @IsIn(['preprod', 'mainnet'])
  @Expose()
  network: 'preprod' | 'mainnet';

  @ApiProperty({ required: false, description: 'Draft accumulated so far, including the user\u2019s manual edits' })
  @IsOptional()
  @IsObject()
  @Expose()
  currentDraft?: Record<string, unknown>;

  @ApiProperty({
    required: false,
    type: [String],
    description: 'Validation errors from the previous draft, fed back so the assistant can correct itself',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  @Expose()
  validationErrors?: string[];
}
