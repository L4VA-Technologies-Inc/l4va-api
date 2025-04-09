import { ApiProperty } from '@nestjs/swagger';
import {IsNotEmpty, IsNumber, IsString} from 'class-validator';
import {Expose} from 'class-transformer';

export class InvestReq {
  @ApiProperty({
    description: 'Amount to invest',
    example: '1000',
  })
  @IsNotEmpty()
  @IsNumber()
  @Expose()
  amount: string;

  @ApiProperty({
    description: 'Currency of investment',
    example: 'USD',
  })
  @IsNotEmpty()
  @IsString()
  @Expose()
  currency: string;
}
