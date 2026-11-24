import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

export class FundBuybackDto {
  @ApiProperty({ description: 'Lovelace to move from the admin wallet into the buyback wallet', example: '100000000' })
  @Matches(/^\d+$/, { message: 'lovelace must be a non-negative integer string' })
  lovelace: string;
}
