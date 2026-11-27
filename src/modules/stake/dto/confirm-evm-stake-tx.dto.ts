import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, Matches } from 'class-validator';

/** Body for `POST /stake/evm/confirm`. */
export class ConfirmEvmStakeTxDto {
  @ApiProperty({ description: 'Hash of the mined L4VAStaking tx sent by the user wallet', example: '0xabc…' })
  @Matches(/^0x[0-9a-fA-F]{64}$/)
  @IsNotEmpty()
  txHash: string;
}
