import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class TriggerHealthCheckRes {
  @Expose()
  @ApiProperty({ description: 'Response message', example: 'Health check completed successfully' })
  message: string;

  @Expose()
  @ApiProperty({ description: 'Number of transactions checked', example: 10 })
  checkedCount: number;
}
