import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class CreateVaultRes {
  @Expose()
  @ApiProperty({ description: 'Vault ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  vaultId: string;

  @Expose()
  @ApiProperty({ description: 'Presigned transaction for vault creation', example: '84a40182825820...' })
  presignedTx: string;
}
