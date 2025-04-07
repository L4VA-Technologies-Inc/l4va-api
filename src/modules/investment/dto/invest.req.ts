import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class InvestReq {
  @ApiProperty({
    description: 'Amount to invest',
    example: '1000',
  })
  @IsNotEmpty()
  @IsString()
  amount: string;

  @ApiProperty({
    description: 'Currency of investment',
    example: 'USD',
  })
  @IsNotEmpty()
  @IsString()
  currency: string;
}
