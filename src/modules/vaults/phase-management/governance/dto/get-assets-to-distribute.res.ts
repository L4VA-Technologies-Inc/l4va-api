import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

import { Asset } from '@/database/asset.entity';

export class GetAssetsToDistributeRes {
  @Expose()
  @ApiProperty({ description: 'List of assets available for distribution', type: [Asset] })
  assets: Asset[];
}
