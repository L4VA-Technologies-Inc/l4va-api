import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class ContributionAsset {
  @ApiProperty({
    description: 'Policy ID of the asset (56-character hex string)',
    example: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd',
  })
  @IsNotEmpty()
  policyId: string;

  @ApiProperty({
    description: 'Asset name/ID within the policy',
    example: 'Asset123',
  })
  @IsNotEmpty()
  assetId: string;

  @ApiProperty({
    description: 'Quantity of assets to contribute',
    example: 1,
  })
  @IsNotEmpty()
  quantity: number;
}

export class ContributeReq {
  @ApiProperty({
    type: [ContributionAsset],
    description: 'List of assets to contribute',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ContributionAsset)
  assets: ContributionAsset[];
}
