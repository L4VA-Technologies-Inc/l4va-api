import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

/** Reserved option values the frontend handles itself instead of sending as a chat message. */
export const UI_ACTION_OPTION_VALUES = ['choose_assets', 'generate_image'] as const;

export type UiActionOptionValue = (typeof UI_ACTION_OPTION_VALUES)[number];

/** A quick reply the chat renders as a button. */
export class VaultAssistantOption {
  @ApiProperty({ description: 'Button text shown to the user' })
  @Expose()
  label: string;

  @ApiProperty({
    description: 'Reply sent on the user’s behalf, or one of the reserved UI actions',
  })
  @Expose()
  value: string;
}
