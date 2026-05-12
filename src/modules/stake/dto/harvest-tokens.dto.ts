import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsNotEmpty, IsString, ValidateNested } from 'class-validator';

import { UtxoRefDto } from './unstake-tokens.dto';

export class HarvestTokensDto {
  @ApiProperty({ example: 'addr1...', description: 'Address of the user harvesting rewards' })
  @IsString()
  @IsNotEmpty()
  userAddress: string;

  @ApiProperty({
    description: 'List of UTxO references (boxes) the user wants to harvest rewards from',
    type: [UtxoRefDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UtxoRefDto)
  utxos: UtxoRefDto[];
}
