import { ApiProperty } from '@nestjs/swagger';

export class AssetMetadataRes {
  @ApiProperty({
    description: 'Display name of the asset from on-chain metadata',
    example: 'SpaceBud #5452',
  })
  displayName: string;
}
