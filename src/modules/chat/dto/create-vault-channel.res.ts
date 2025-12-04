import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class CreateVaultChannelRes {
  @Expose()
  @ApiProperty({ description: 'Channel ID', example: 'vault-123e4567-e89b-12d3-a456-426614174000' })
  channelId: string;

  @Expose()
  @ApiProperty({ description: 'Channel type', example: 'messaging' })
  channelType: string;

  @Expose()
  @ApiProperty({ description: 'Whether the operation was successful', example: true })
  success: boolean;
}
