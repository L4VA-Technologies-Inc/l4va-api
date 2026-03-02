import { ApiProperty } from '@nestjs/swagger';

export class VlrmFeeResponseDto {
  @ApiProperty({ description: 'VLRM creator fee in basis points' })
  vlrm_creator_fee: number;

  @ApiProperty({ description: 'Enable or disable VLRM creator fee' })
  vlrm_creator_fee_enabled: boolean;
}
