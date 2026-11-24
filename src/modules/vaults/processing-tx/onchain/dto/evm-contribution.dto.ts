import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, IsUUID } from 'class-validator';

export class PrepareEvmContributionReq {
  @ApiProperty({ description: 'ID of the pending contribution Transaction row' })
  @IsUUID()
  txId: string;

  @ApiPropertyOptional({
    description:
      'Hash of the native protocol-fee transfer. Send it on the second prepare call, after paying the `feePayment` returned by the first.',
    example: '0x632624fbe9065b1d0b47781b5edabbc44f7b63a5fe18a69bf3a7631244d5cb81',
  })
  @IsOptional()
  @IsString()
  feeTxHash?: string;
}

export class ConfirmEvmContributionReq {
  @ApiProperty({ description: 'ID of the pending contribution Transaction row' })
  @IsUUID()
  txId: string;

  @ApiProperty({
    description: 'Primary on-chain transaction hash (usually the last contribute call).',
    example: '0x632624fbe9065b1d0b47781b5edabbc44f7b63a5fe18a69bf3a7631244d5cb81',
  })
  @IsString()
  txHash: string;

  @ApiPropertyOptional({
    description: 'All on-chain contribution tx hashes, in submission order.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  childTxHashes?: string[];
}
