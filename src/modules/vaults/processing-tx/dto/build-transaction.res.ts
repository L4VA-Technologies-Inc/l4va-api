import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class BuildTransactionRes {
  @Expose()
  @ApiProperty({ description: 'Presigned transaction', example: '84a40182825820...' })
  presignedTx: string;
}
