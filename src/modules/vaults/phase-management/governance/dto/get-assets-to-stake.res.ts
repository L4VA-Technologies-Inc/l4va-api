import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

import { Asset } from '@/database/asset.entity';

export class GetAssetsToStakeRes {
  @Expose()
  @ApiProperty({ description: 'List of assets available for staking', type: [Asset] })
  assets: Asset[];
}
