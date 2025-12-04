import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class PublishBurnTransactionRes {
  @Expose()
  @ApiProperty({ description: 'Transaction hash', example: '0x1234567890abcdef...' })
  txHash: string;
}
