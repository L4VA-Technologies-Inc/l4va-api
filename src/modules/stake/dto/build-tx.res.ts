import { ApiProperty } from '@nestjs/swagger';

export class BuildTxRes {
  @ApiProperty({ example: true, description: 'Whether transaction building succeeded' })
  success: boolean;

  @ApiProperty({
    required: false,
    description: 'Unsigned transaction CBOR hex for the client to sign',
    example: '84a40081825820...',
  })
  txCbor?: string;

  @ApiProperty({
    required: false,
    description: 'Internal transaction id (transactions table) — pass back to POST /stake/submit',
    format: 'uuid',
  })
  transactionId?: string;

  @ApiProperty({ required: false, description: 'Error or informational message when success is false' })
  message?: string;
}
