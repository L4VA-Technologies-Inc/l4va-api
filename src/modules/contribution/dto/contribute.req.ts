import { ApiProperty } from '@nestjs/swagger';
import {IsArray, IsNotEmpty, ValidateNested} from 'class-validator';
import {Expose, Type} from 'class-transformer';

class ContributionAsset {
  @ApiProperty({
    description: 'Policy ID of the asset (56-character hex string)',
    example: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd',
  })
  @Expose()
  policyId: string;

  @ApiProperty({
    description: 'Asset name within the policy',
    example: 'l4vaaudiEngine',
  })
  @IsNotEmpty()
  @Expose()
  assetName: string;

  @ApiProperty({
    description: 'Quantity of assets to contribute',
    example: 1,
  })
  @IsNotEmpty()
  @Expose()
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
  @Expose()
  assets: ContributionAsset[];
}
