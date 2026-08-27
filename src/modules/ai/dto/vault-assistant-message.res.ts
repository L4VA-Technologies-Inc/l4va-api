import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';

import { VaultAssistantAction } from './vault-assistant-action';

export class VaultAssistantMessageRes {
  @ApiProperty({ description: 'Assistant reply to show in the chat' })
  @Expose()
  message: string;

  @ApiProperty({ enum: ['gathering', 'ready'] })
  @Expose()
  status: 'gathering' | 'ready';

  @ApiProperty({ description: 'Sanitized partial vault draft to merge into the form state' })
  @Expose()
  vaultDraft: Record<string, unknown>;

  @ApiProperty({
    description: 'When true, vaultDraft replaces the client draft instead of merging onto it (user asked to reset)',
  })
  @Expose()
  resetDraft: boolean;

  @ApiProperty({ type: [String], description: 'Required fields that still have no value' })
  @Expose()
  missingFields: string[];

  @ApiProperty({ type: [String], description: 'Values the assistant proposed that were rejected by the server' })
  @Expose()
  rejected: string[];

  @ApiProperty({ description: 'Spec version the draft was produced against' })
  @Expose()
  specVersion: string;

  @ApiProperty({
    type: VaultAssistantAction,
    nullable: true,
    description: 'Action the assistant requested and the server validated, e.g. a launch confirmation',
  })
  @Type(() => VaultAssistantAction)
  @Expose()
  action: VaultAssistantAction | null;
}
