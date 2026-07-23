import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class CreateVaultRes {
  @Expose()
  @ApiProperty({ description: 'Vault ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  vaultId: string;

  // ---- Cardano fields (null for EVM vaults) --------------------------------

  @Expose()
  @ApiProperty({
    description: 'Presigned transaction for vault creation',
    example: '84a40182825820...',
    required: false,
  })
  presignedTx?: string;

  @Expose()
  @ApiProperty({ description: 'Internal transaction ID', required: false })
  txId?: string;

  // ---- EVM fields (null for Cardano vaults) --------------------------------

  @Expose()
  @ApiProperty({ description: 'EIP-712 admin signature for VaultFactory.createVault', required: false })
  adminSignature?: string;

  @Expose()
  @ApiProperty({ description: 'Admin nonce consumed by this authorization', required: false })
  adminNonce?: string;

  @Expose()
  @ApiProperty({ description: 'Unix timestamp after which the admin signature expires', required: false })
  deadline?: number;

  @Expose()
  @ApiProperty({ description: 'Full VaultConfig struct to pass to VaultFactory.createVault', required: false })
  evmVaultConfig?: Record<string, unknown>;
}
