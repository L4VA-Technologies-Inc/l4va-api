import { ApiProperty } from '@nestjs/swagger';
import {IsNotEmpty, IsNumber, IsString} from 'class-validator';
import {Expose} from 'class-transformer';

export class AcquireReq {
  @ApiProperty({
    description: 'Amount to invest',
    example: '1000',
  })
  @IsNotEmpty()
  @IsNumber()
  @Expose()
  amount: string;

  @ApiProperty({
    description: 'Currency of acquire',
    example: 'USD',
  })
  @IsNotEmpty()
  @IsString()
  @Expose()
  currency: string;
}
