import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';

export class StakeTokenItemDto {
  @ApiProperty({
    example:
      '2bd0c232f221b65b28a5ca0fce1adbefac04c43cb75ddbc2b2cb0f1b3505a6451ddd073c51fd04b2094d6abeaa7fc338eb9bc28a9ec67e1eaf935939',
    description: 'Asset id / unit (policyId + assetName in hex).',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[0-9a-fA-F]{56,}$/, {
    message: 'assetId must be a hex string starting with a 56-char policyId',
  })
  assetId: string;

  @ApiProperty({
    example: 100.56,
    description: 'Human-readable token amount. Backend resolves the correct decimal precision per token.',
  })
  @IsNumber({ maxDecimalPlaces: 4 }, { message: 'amount must be a number with up to 4 decimal places' })
  @IsPositive({ message: 'amount must be greater than 0' })
  amount: number;
}

export class StakeTokensDto {
  @ApiProperty({ example: 'addr1...', description: 'Address of the user staking tokens' })
  @IsString()
  @IsNotEmpty()
  userAddress: string;

  @ApiProperty({
    description:
      'Tokens to stake (1 or 2). Each token is placed into its own UTxO at the contract. ' +
      'No duplicate assetId values allowed.',
    type: [StakeTokenItemDto],
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'At least one token must be provided' })
  @ArrayMaxSize(2, { message: 'At most two tokens can be staked at once' })
  @ValidateNested({ each: true })
  @Type(() => StakeTokenItemDto)
  tokens: StakeTokenItemDto[];
}
