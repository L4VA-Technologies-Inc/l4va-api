import { Controller, UseGuards, Body, Post, Get } from '@nestjs/common';
import { ApiBody, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ApiDoc } from '../../decorators/api-doc.decorator';
import { AuthGuard } from '../auth/auth.guard';

import { PaginationQueryDto } from './dto/pagination.dto';
import { VaultTokensMarketStatsDto } from './dto/vault-tokens-market-stats.dto';
import { PaginatedWalletSummaryDto } from './dto/wallet-summary.dto';
import { TaptoolsService } from './taptools.service';

@Controller('taptools')
@ApiTags('TapTools')
export class TaptoolsController {
  constructor(private readonly taptoolsService: TaptoolsService) {}

  @Post('summary')
  @ApiDoc({
    summary: 'Get paginated wallet summary',
    description: 'Returns paginated assets from a wallet with optional filtering',
    status: 200,
  })
  @ApiResponse({ status: 200, type: PaginatedWalletSummaryDto })
  @ApiBody({ type: PaginationQueryDto })
  @UseGuards(AuthGuard)
  async getWalletSummaryPaginated(@Body() body: PaginationQueryDto): Promise<PaginatedWalletSummaryDto> {
    return this.taptoolsService.getWalletSummaryPaginated(body);
  }

  @Get('vault-tokens/market-stats')
  @ApiDoc({
    summary: 'Get vault tokens market statistics',
    description: 'Returns market statistics for vault tokens including price, market cap, and price changes',
    status: 200,
  })
  @ApiResponse({ status: 200, type: [VaultTokensMarketStatsDto] })
  async getVaultTokensMarketStats(): Promise<VaultTokensMarketStatsDto[]> {
    return this.taptoolsService.getVaultTokensMarketStats();
  }
}
