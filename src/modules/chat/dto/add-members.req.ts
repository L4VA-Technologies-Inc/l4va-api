import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsArray, IsString, IsUUID, ArrayMinSize } from 'class-validator';

export class AddMembersReq {
  @Expose()
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @IsUUID('4', { each: true })
  @ApiProperty({
    description: 'Array of user IDs to add to the channel',
    type: [String],
    example: ['123e4567-e89b-12d3-a456-426614174000', '123e4567-e89b-12d3-a456-426614174001'],
  })
  userIds: string[];
}
