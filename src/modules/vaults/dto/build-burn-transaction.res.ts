import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class BuildBurnTransactionRes {
  @Expose()
  @ApiProperty({ description: 'Transaction ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  txId: string;

  @Expose()
  @ApiProperty({ description: 'Presigned transaction', example: '84a40182825820...' })
  presignedTx: string;
}
