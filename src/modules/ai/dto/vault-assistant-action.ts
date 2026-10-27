import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

/**
 * Backend → frontend protocol for something the UI should offer the user.
 *
 * Deliberately not the OpenAI tool-call shape: the model's tool call is an internal request, this
 * is the reviewed, validated result of it.
 */
export class VaultAssistantAction {
  @ApiProperty({ enum: ['confirmation'], description: 'How the frontend should present the action' })
  @Expose()
  type: 'confirmation';

  @ApiProperty({ description: 'Name of the capability the action maps to, e.g. "launch_vault"' })
  @Expose()
  name: string;

  @ApiProperty({ description: 'Button label' })
  @Expose()
  label: string;

  @ApiProperty({ required: false, description: 'Short explanation shown alongside the confirmation' })
  @Expose()
  description?: string;
}
