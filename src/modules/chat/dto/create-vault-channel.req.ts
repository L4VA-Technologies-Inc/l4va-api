import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateVaultChannelReq {
  @Expose()
  @IsOptional()
  @IsString()
  @IsUUID()
  @ApiProperty({
    description: 'User ID who created the channel',
    example: '123e4567-e89b-12d3-a456-426614174000',
    required: false,
  })
  createdByUserId?: string;
}
