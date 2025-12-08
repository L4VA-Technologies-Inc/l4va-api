import { Controller, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

import { WayUpService } from './wayup.service';

import { TransactionBuildResponse } from '@/modules/vaults/processing-tx/onchain/types/transaction-status.enum';

interface NFTListingDto {
  vaultId: string;
  listings: Array<{
    policyId: string;
    assetName: string;
    priceAda: number;
  }>;
}

interface BuildListingDto {
  vaultId: string;
  policyIds?: Array<{ id: string; priceAda: number }>;
}

interface UnlistNFTDto {
  vaultId: string;
  unlistings: Array<{
    policyId: string;
    txHashIndex: string; // Format: txHash#outputIndex
  }>;
}

interface UpdateListingDto {
  vaultId: string;
  updates: Array<{
    policyId: string;
    txHashIndex: string; // Format: txHash#outputIndex
    newPriceAda: number;
  }>;
}

interface MakeOfferDto {
  vaultId: string;
  offers: Array<{
    policyId: string;
    assetName: string;
    priceAda: number;
  }>;
}

interface BuyNFTDto {
  vaultId: string;
  purchases: Array<{
    policyId: string;
    txHashIndex: string; // Format: txHash#outputIndex
    priceAda: number;
  }>;
}

@ApiTags('wayup')
@Controller('wayup')
export class WayUpController {
  constructor(private readonly wayUpService: WayUpService) {}

  @Post('list-nfts')
  @ApiOperation({ summary: 'Build listing transaction for NFTs (legacy)' })
  @ApiResponse({ status: 200, description: 'Transaction built successfully' })
  async listNFTs(@Body() body: BuildListingDto): Promise<TransactionBuildResponse> {
    return this.wayUpService.listNFTs(body.vaultId, body.policyIds);
  }

  @Post('create-listing')
  @ApiOperation({ summary: 'Create NFT listing on WayUp Marketplace (build, sign, and submit)' })
  @ApiResponse({
    status: 200,
    description: 'Listing created successfully',
    schema: {
      properties: {
        txHash: { type: 'string' },
        listedAssets: { type: 'array' },
      },
    },
  })
  async createListing(
    @Body() body: NFTListingDto
  ): Promise<{ txHash: string; listedAssets: Array<{ policyId: string; assetName: string; priceAda: number }> }> {
    return this.wayUpService.createListing(body.vaultId, body.listings);
  }

  @Post('unlist-nfts')
  @ApiOperation({ summary: 'Unlist NFTs from WayUp Marketplace (build, sign, and submit)' })
  @ApiResponse({
    status: 200,
    description: 'NFTs unlisted successfully',
    schema: {
      properties: {
        txHash: { type: 'string' },
        unlistedAssets: { type: 'array' },
      },
    },
  })
  async unlistNFTs(
    @Body() body: UnlistNFTDto
  ): Promise<{ txHash: string; unlistedAssets: Array<{ policyId: string; txHashIndex: string }> }> {
    return this.wayUpService.unlistNFTs(body.vaultId, body.unlistings);
  }

  @Post('update-listing')
  @ApiOperation({ summary: 'Update NFT listing price on WayUp Marketplace (build, sign, and submit)' })
  @ApiResponse({
    status: 200,
    description: 'Listing price updated successfully',
    schema: {
      properties: {
        txHash: { type: 'string' },
        updatedAssets: { type: 'array' },
      },
    },
  })
  async updateListing(@Body() body: UpdateListingDto): Promise<{
    txHash: string;
    updatedAssets: Array<{ policyId: string; txHashIndex: string; newPriceAda: number }>;
  }> {
    return this.wayUpService.updateListing(body.vaultId, body.updates);
  }

  @Post('make-offer')
  @ApiOperation({ summary: 'Make an offer (bid) on NFTs in WayUp Marketplace (build, sign, and submit)' })
  @ApiResponse({
    status: 200,
    description: 'Offer created successfully',
    schema: {
      properties: {
        txHash: { type: 'string' },
        offers: { type: 'array' },
      },
    },
  })
  async makeOffer(@Body() body: MakeOfferDto): Promise<{
    txHash: string;
    offers: Array<{ policyId: string; assetName: string; priceAda: number }>;
  }> {
    return this.wayUpService.makeOffer(body.vaultId, body.offers);
  }

  @Post('buy-nft')
  @ApiOperation({ summary: 'Buy NFTs from WayUp Marketplace (build, sign, and submit)' })
  @ApiResponse({
    status: 200,
    description: 'NFT purchase completed successfully',
    schema: {
      properties: {
        txHash: { type: 'string' },
        purchases: { type: 'array' },
      },
    },
  })
  async buyNFT(@Body() body: BuyNFTDto): Promise<{
    txHash: string;
    purchases: Array<{ policyId: string; txHashIndex: string; priceAda: number }>;
  }> {
    return this.wayUpService.buyNFT(body.vaultId, body.purchases);
  }
}
