import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

export class SubmitListingTxDto {
  @ApiProperty({ description: 'Transaction hex string' })
  @IsString()
  @IsNotEmpty()
  transaction: string;

  @ApiProperty({ description: 'Transaction signature' })
  @IsString()
  @IsNotEmpty()
  signature: string;
}
