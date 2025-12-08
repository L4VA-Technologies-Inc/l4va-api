import { Controller, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

import { WayUpService } from './wayup.service';

import {
  TransactionBuildResponse,
  TransactionSubmitResponse,
} from '@/modules/vaults/processing-tx/onchain/types/transaction-status.enum';

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

interface SubmitTransactionDto {
  signedTxHex: string;
}

interface UnlistNFTDto {
  vaultId: string;
  unlistings: Array<{
    policyId: string;
    txHashIndex: string; // Format: txHash#outputIndex
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

  @Post('submit')
  @ApiOperation({ summary: 'Submit a pre-signed transaction to the blockchain' })
  @ApiResponse({ status: 200, description: 'Transaction submitted successfully' })
  async submitTransaction(@Body() body: SubmitTransactionDto): Promise<TransactionSubmitResponse> {
    return this.wayUpService.submitTransaction(body.signedTxHex);
  }
}
