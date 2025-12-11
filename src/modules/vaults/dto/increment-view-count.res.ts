import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class IncrementViewCountRes {
  @Expose()
  @ApiProperty({ description: 'Indicates if the view count was successfully incremented', example: true })
  success: boolean;
}
