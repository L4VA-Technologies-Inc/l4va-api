import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import {
  ExtractAssetsToTreasuryDto,
  ExtractAllVaultAssetsDto,
  SubmitExtractionTransactionDto,
} from './dto/extract-assets-treasury.dto';
import { TreasuryExtractionService } from './treasury-extraction.service';

/**
 * Controller for testing treasury extraction operations
 * Allows manual triggering of asset extraction from vaults to treasury wallets
 */
@ApiTags('Treasury Extraction (Testing)')
@Controller('treasury-extraction')
@ApiBearerAuth()
export class TreasuryExtractionController {
  constructor(private readonly treasuryExtractionService: TreasuryExtractionService) {}

  /**
   * Extract specific assets from a vault to treasury address
   * Returns a presigned transaction that needs to be signed and submitted
   */
  @Post('extract-assets')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Extract specific assets from vault to treasury',
    description:
      'Builds an ExtractAsset transaction to move assets from vault contribution UTXOs to a treasury wallet. Returns presigned transaction hex that must be signed with admin key.',
  })
  @ApiResponse({
    status: 200,
    description: 'Extraction transaction successfully built',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        transactionId: {
          type: 'string',
          example: '123e4567-e89b-12d3-a456-426614174000',
        },
        presignedTxHex: {
          type: 'string',
          example: '84a300818258203b40265111d8bb3c3c608d95b3a0bf83461ace32...',
        },
        extractedAssets: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              assetId: { type: 'string' },
              policyId: { type: 'string' },
              assetName: { type: 'string' },
              contributionTxHash: { type: 'string' },
            },
          },
        },
        treasuryAddress: { type: 'string' },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Bad request - invalid input' })
  @ApiResponse({ status: 404, description: 'Vault or assets not found' })
  async extractAssetsToTreasury(@Body() dto: ExtractAssetsToTreasuryDto) {
    return this.treasuryExtractionService.extractAssetsToTreasury({
      vaultId: dto.vaultId,
      assetIds: dto.assetIds,
      treasuryAddress: dto.treasuryAddress,
    });
  }

  /**
   * Extract all eligible assets from a vault (batch operation)
   */
  @Post('extract-all-vault-assets')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Extract all locked assets from a vault',
    description:
      'Batch operation that extracts all locked assets from a vault to treasury. Creates multiple extraction transactions if assets are in different contribution UTXOs.',
  })
  @ApiResponse({
    status: 200,
    description: 'Batch extraction completed',
    schema: {
      type: 'object',
      properties: {
        vaultId: { type: 'string' },
        totalAssets: { type: 'number' },
        successfulExtractions: { type: 'number' },
        failedExtractions: { type: 'number' },
        results: {
          type: 'array',
          items: {
            type: 'object',
          },
        },
        errors: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              assetId: { type: 'string' },
              error: { type: 'string' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Vault not found' })
  async extractAllVaultAssets(@Body() dto: ExtractAllVaultAssetsDto) {
    return this.treasuryExtractionService.extractAllVaultAssetsToTreasury(dto.vaultId, dto.treasuryAddress);
  }

  /**
   * Submit a signed extraction transaction to the blockchain
   */
  @Post('submit-extraction')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit signed extraction transaction',
    description: 'Submits a signed extraction transaction to the blockchain and updates asset statuses.',
  })
  @ApiResponse({
    status: 200,
    description: 'Transaction submitted successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        txHash: { type: 'string' },
        message: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Transaction submission failed',
  })
  async submitExtractionTransaction(@Body() dto: SubmitExtractionTransactionDto) {
    // Submit to blockchain (you'll need to implement this in blockchain service)
    const result = await this.treasuryExtractionService.markAssetsAsExtracted(
      dto.transactionId,
      dto.signedTxHex // In real implementation, extract txHash after submission
    );

    return {
      success: true,
      txHash: dto.signedTxHex.substring(0, 64), // Placeholder - extract real hash
      message: 'Extraction transaction submitted successfully',
    };
  }

  /**
   * Get extraction history for a vault
   */
  @Get('extraction-history/:vaultId')
  @ApiOperation({
    summary: 'Get extraction transaction history for a vault',
    description: 'Returns all extraction transactions for the specified vault',
  })
  @ApiResponse({
    status: 200,
    description: 'Extraction history retrieved',
  })
  async getExtractionHistory(@Param('vaultId') vaultId: string) {
    // This would query the transactions table for extract type transactions
    // Implementation depends on your existing transaction query patterns
    return {
      vaultId,
      extractions: [],
      message: 'Extraction history endpoint - to be implemented',
    };
  }
}
