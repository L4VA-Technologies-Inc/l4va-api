import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsString, Matches, Min } from 'class-validator';

export class StakeTokensDto {
  @ApiProperty({ example: 'addr1...', description: 'Address of the user staking tokens' })
  @IsString()
  @IsNotEmpty()
  userAddress: string;

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
    description:
      'Human-readable token amount (e.g. 100.56 VLRM). Backend converts to raw on-chain integer using 4 decimals.',
  })
  @IsNumber()
  @Min(0, { message: 'amount must be greater than 0' })
  amount: number;
}
