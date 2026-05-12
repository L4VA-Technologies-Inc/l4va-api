import { ApiProperty } from '@nestjs/swagger';

export class SubmitTxRes {
  @ApiProperty({ example: true, description: 'Whether the transaction was submitted to the network' })
  success: boolean;

  @ApiProperty({
    required: false,
    description: 'On-chain transaction hash',
    example: '2a5b8c9d1e3f4a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0',
  })
  txHash?: string;

  @ApiProperty({ required: false, description: 'Error message when success is false' })
  message?: string;

  @ApiProperty({
    required: false,
    description: 'Internal ledger id (transactions table) when a stake row was stored',
  })
  transactionId?: string;
}
