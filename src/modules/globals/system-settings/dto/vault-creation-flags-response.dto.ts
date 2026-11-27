import { ApiProperty } from '@nestjs/swagger';

import { VaultArchetype } from '@/types/index-vault.types';
import { ChainType } from '@/types/vault.types';

export class VaultCreationFlagsResponseDto {
  @ApiProperty({ description: 'Whether EVM (Robinhood-chain) vault flows are available at all' })
  evm_enabled: boolean;

  @ApiProperty({ description: 'Whether NFT (ERC721/ERC1155) assets are enabled on EVM (Robinhood-chain) vaults' })
  evm_nft_assets_enabled: boolean;

  @ApiProperty({ description: 'Robinhood: owner may cancel an acquire-only vault during the acquire window' })
  evm_vault_cancel_enabled: boolean;

  @ApiProperty({ description: 'Robinhood: contributors may withdraw their own contributions while the window is open' })
  evm_contribution_withdraw_enabled: boolean;

  @ApiProperty({ description: 'Robinhood: L4VA staking (L4VAStaking contract) is available' })
  evm_staking_enabled: boolean;

  @ApiProperty({
    description:
      'Vault archetypes a creator may choose, per chain. A chain with a single entry has no vault-type choice to make.',
    example: { [ChainType.cardano]: [VaultArchetype.standard], [ChainType.robinhood]: [VaultArchetype.index_weighted] },
  })
  vault_archetypes_enabled: Record<string, VaultArchetype[]>;

  @ApiProperty({
    description:
      'Most ERC-20s a NEW Robinhood vault may be built around (index basket, asset whitelist): the current ' +
      "factory's MAX_TERMINATION_ASSETS minus the slot kept for native ETH.",
    example: 15,
  })
  evm_max_basket_assets: number;
}
