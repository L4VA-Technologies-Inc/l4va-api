import { ApiProperty } from '@nestjs/swagger';
import { IsArray, ValidateNested } from 'class-validator';
import { Expose, Type } from 'class-transformer';
import { ContributionAsset } from '../../contribution/dto/contribute.req';

export class AcquireReq {
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
