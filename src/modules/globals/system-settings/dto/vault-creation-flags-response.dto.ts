import { ApiProperty } from '@nestjs/swagger';

import { VaultArchetype } from '@/types/index-vault.types';
import { ChainType } from '@/types/vault.types';

export class VaultCreationFlagsResponseDto {
  @ApiProperty({ description: 'Whether NFT (ERC721/ERC1155) assets are enabled on EVM (Robinhood-chain) vaults' })
  evm_nft_assets_enabled: boolean;

  @ApiProperty({
    description:
      'Vault archetypes a creator may choose, per chain. A chain with a single entry has no vault-type choice to make.',
    example: { [ChainType.cardano]: [VaultArchetype.standard], [ChainType.robinhood]: [VaultArchetype.index_weighted] },
  })
  vault_archetypes_enabled: Record<string, VaultArchetype[]>;
}
