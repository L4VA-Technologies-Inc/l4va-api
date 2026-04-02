import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsNotEmpty, IsString, Min, ValidateNested } from 'class-validator';

export class UtxoRefDto {
  @ApiProperty({ example: 'abc123...', description: 'Transaction hash of the UTxO to unstake' })
  @IsString()
  @IsNotEmpty()
  txHash: string;

  @ApiProperty({ example: 0, description: 'Output index of the UTxO to unstake' })
  @IsInt()
  @Min(0)
  outputIndex: number;
}

export class UnstakeTokensDto {
  @ApiProperty({ example: 'addr1...', description: 'Address of the user unstaking tokens' })
  @IsString()
  @IsNotEmpty()
  userAddress: string;

  @ApiProperty({
    description: 'List of UTxO references (boxes) the user wants to unstake',
    type: [UtxoRefDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UtxoRefDto)
  utxos: UtxoRefDto[];
}
