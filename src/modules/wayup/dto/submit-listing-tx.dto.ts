import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString } from 'class-validator';

export class SubmitListingTxDto {
  @ApiProperty({
    description: 'Array of signed transaction hex strings',
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  transactions: string[];
}
