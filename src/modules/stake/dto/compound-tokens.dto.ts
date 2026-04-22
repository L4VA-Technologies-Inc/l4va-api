import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsNotEmpty, IsString, ValidateNested } from 'class-validator';

import { UtxoRefDto } from './unstake-tokens.dto';

export class CompoundTokensDto {
  @ApiProperty({ example: 'addr1...', description: 'Address of the user compounding rewards' })
  @IsString()
  @IsNotEmpty()
  userAddress: string;

  @ApiProperty({
    description: 'List of UTxO references (boxes) the user wants to compound (restake rewards into)',
    type: [UtxoRefDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UtxoRefDto)
  utxos: UtxoRefDto[];
}
