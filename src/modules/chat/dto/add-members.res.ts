import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class AddMembersRes {
  @Expose()
  @ApiProperty({ description: 'Whether the operation was successful', example: true })
  success: boolean;
}
