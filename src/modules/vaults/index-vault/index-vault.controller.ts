import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';

import { IndexBasketReq } from './dto/index-basket.dto';
import { IndexVaultService } from './index-vault.service';

import { AdminGuard } from '@/modules/auth/admin.guard';
import { AuthGuard } from '@/modules/auth/auth.guard';

@ApiTags('Index vaults')
@Controller('vaults')
export class IndexVaultController {
  constructor(private readonly indexVaultService: IndexVaultService) {}

  @Get('index/assets')
  @ApiOperation({
    summary: 'Tokens an index basket may hold',
    description: 'When `restricted` is false any token the swap adapter can quote is accepted.',
  })
  getSupportedAssets(): ReturnType<IndexVaultService['getSupportedAssets']> {
    return this.indexVaultService.getSupportedAssets();
  }

  @Get('index/assets/:address/routes')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Whether a token can be bought with ETH and sold back to ETH through Uniswap',
    description:
      "Uses the same routing as trade execution. Pass `vaultId` to check with that vault's swap adapter; " +
      'without it the check is for a new vault. `status` is ok, no_route or unavailable (Uniswap did not answer).',
  })
  @ApiQuery({ name: 'vaultId', required: false })
  checkAssetRoutes(
    @Param('address') address: string,
    @Query('vaultId') vaultId?: string
  ): ReturnType<IndexVaultService['checkAssetRoutes']> {
    return this.indexVaultService.checkAssetRoutes(address, vaultId || undefined);
  }

  @Get(':id/index')
  @ApiOperation({
    summary: 'Index-weighted vault basket, live allocation and rebalance history',
    description: 'Holdings are valued by swap quotes into native and cached for one minute.',
  })
  getIndexOverview(@Param('id', ParseUUIDPipe) vaultId: string): ReturnType<IndexVaultService['getOverview']> {
    return this.indexVaultService.getOverview(vaultId);
  }

  @Post(':id/index/preview')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Estimate the trades a re-weight to this basket would make',
    description:
      'Resolves every basket asset on chain and reads the live portfolio, so it is restricted to authenticated callers.',
  })
  previewReweight(
    @Param('id', ParseUUIDPipe) vaultId: string,
    @Body() body: IndexBasketReq
  ): ReturnType<IndexVaultService['previewReweight']> {
    return this.indexVaultService.previewReweight(vaultId, body.targets, body.reserveBps);
  }

  @Post(':id/index/rebalances/:rebalanceId/retry')
  @UseGuards(AdminGuard)
  @ApiSecurity('Admin-Token')
  @ApiOperation({ summary: 'Operator retry of a failed basket rebalance' })
  retryRebalance(
    @Param('id', ParseUUIDPipe) vaultId: string,
    @Param('rebalanceId', ParseUUIDPipe) rebalanceId: string
  ): ReturnType<IndexVaultService['retryRebalance']> {
    return this.indexVaultService.retryRebalance(vaultId, rebalanceId);
  }
}
