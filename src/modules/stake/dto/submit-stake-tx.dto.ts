import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

/**
 * Body for `POST /stake/submit`.
 * `transactionId` is the uuid returned by `POST /stake/build-stake`.
 */
export class SubmitStakeTxDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Transaction id returned by POST /stake/build-stake',
  })
  @IsUUID()
  @IsNotEmpty()
  transactionId: string;

  @ApiProperty({ description: 'Unsigned transaction CBOR hex returned by build-stake / build-unstake' })
  @IsString()
  @IsNotEmpty()
  txCbor: string;

  @ApiProperty({ description: 'CIP-30 partial signature (witness) hex from the user wallet' })
  @IsString()
  @IsNotEmpty()
  signature: string;
}
