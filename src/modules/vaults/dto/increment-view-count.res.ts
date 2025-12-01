import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class IncrementViewCountRes {
  @Expose()
  @ApiProperty({ description: 'Number of affected rows', example: 1 })
  affected: number;

  @Expose()
  @ApiProperty({ description: 'Whether any rows were affected', example: true })
  generatedMaps: unknown[];

  @Expose()
  @ApiProperty({ description: 'Raw database result', required: false })
  raw?: unknown;
}
