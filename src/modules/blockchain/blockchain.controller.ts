import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { BlockchainService } from './blockchain.service';
import { ApiTags } from '@nestjs/swagger';
import { ApiDoc } from '../../decorators/api-doc.decorator';
import { AuthGuard } from '../auth/auth.guard';

@ApiTags('blockchain')
@Controller('blockchain')
export class BlockchainController {
  constructor(private readonly blockchainService: BlockchainService) {}

  @ApiDoc({
    summary: 'Get asset history',
    description: 'Retrieve blockchain transaction history for an asset',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Get('assets/:assetId/history')
  getAssetHistory(@Param('assetId') assetId: string) {
    return this.blockchainService.getAssetHistory(assetId);
  }

  @ApiDoc({
    summary: 'Get vault status',
    description: 'Get current vault status from blockchain',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Get('vaults/:vaultId/status')
  getVaultStatus(@Param('vaultId') vaultId: string) {
    return this.blockchainService.getVaultStatus(vaultId);
  }

  @ApiDoc({
    summary: 'Update vault metadata',
    description: 'Update vault metadata on blockchain',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Post('vaults/:vaultId/metadata')
  updateVaultMetadata(
    @Param('vaultId') vaultId: string,
    @Body() metadata: any
  ) {
    return this.blockchainService.updateVaultMetadata(vaultId, metadata);
  }
}
