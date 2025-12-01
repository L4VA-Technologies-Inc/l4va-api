import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID } from 'class-validator';

export class CreateSnapshotVaultParamDto {
  @ApiProperty({
    description: 'Vault ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsString()
  @IsUUID()
  vaultId: string;
}

export class CreateSnapshotAssetParamDto {
  @ApiProperty({
    description: 'Asset ID (concatenation of policy ID and hex-encoded asset name)',
    example: 'policy123hexname',
  })
  @IsString()
  assetId: string;
}
