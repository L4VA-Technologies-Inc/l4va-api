import { ApiProperty } from '@nestjs/swagger';

export class TreasuryWalletInfoDto {
  @ApiProperty({
    description: 'Treasury wallet ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  id: string;

  @ApiProperty({
    description: 'Vault ID associated with this treasury wallet',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  vaultId: string;

  @ApiProperty({
    description: 'Cardano address of the treasury wallet',
    example: 'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x',
  })
  address: string;

  @ApiProperty({
    description: 'Public key hash of the treasury wallet',
    example: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6',
  })
  publicKeyHash: string;

  @ApiProperty({
    description: 'Timestamp when the treasury wallet was created',
    example: '2024-01-15T10:30:00.000Z',
  })
  createdAt: Date;
}
