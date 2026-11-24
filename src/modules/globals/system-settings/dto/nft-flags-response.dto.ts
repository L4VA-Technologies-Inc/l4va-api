import { ApiProperty } from '@nestjs/swagger';

export class NftFlagsResponseDto {
  @ApiProperty({ description: 'Whether NFT (ERC721/ERC1155) assets are enabled on EVM (Robinhood-chain) vaults' })
  evm_nft_assets_enabled: boolean;
}
