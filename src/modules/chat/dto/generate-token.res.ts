import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class GenerateTokenRes {
  @Expose()
  @ApiProperty({ description: 'Stream Chat token for the user', example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  token: string;
}
