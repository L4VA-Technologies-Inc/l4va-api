import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID } from 'class-validator';

export class GetPublicProfileParamDto {
  @ApiProperty({
    description: 'User ID to get public profile for',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsString()
  @IsUUID()
  id: string;
}
