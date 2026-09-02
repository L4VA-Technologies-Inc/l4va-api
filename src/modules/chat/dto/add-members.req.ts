import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsArray, IsOptional, IsString, IsUUID } from 'class-validator';

export class AddMembersReq {
  @Expose()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @IsUUID('4', { each: true })
  @ApiProperty({
    description: 'Optional list of user IDs. Omitted body adds the authenticated user. Other users are rejected.',
    type: [String],
    required: false,
    example: ['123e4567-e89b-12d3-a456-426614174000'],
  })
  userIds?: string[];
}
