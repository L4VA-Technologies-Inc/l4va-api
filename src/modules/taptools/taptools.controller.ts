import { Controller, UseGuards, Body, Post, Get, Query } from '@nestjs/common';
import { ApiBody, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ApiDoc } from '../../decorators/api-doc.decorator';
import { AuthGuard } from '../auth/auth.guard';

import { PaginationQueryDto } from './dto/pagination.dto';
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

  // TODO: TEMPORARY TEST ENDPOINT - DELETE AFTER TESTING
  @Get('test-vyfi-lp-price')
  @ApiDoc({
    summary: '[TEST] Calculate VyFi LP token price',
    description: 'Temporary endpoint to test VyFi LP token price calculation. DELETE AFTER TESTING.',
    status: 200,
  })
  async testVyFiLpPrice(
    @Query('tokenA') tokenAUnit: string,
    @Query('tokenB') tokenBUnit: string,
    @Query('lpToken') lpTokenUnit: string
  ): Promise<{
    success: boolean;
    price: number | null;
    priceAda: number | null;
    tokenA: string;
    tokenB: string;
    lpToken: string;
  }> {
    const price = await this.taptoolsService.calculateVyFiLpTokenPrice(tokenAUnit, tokenBUnit, lpTokenUnit);

    return {
      success: price !== null,
      price,
      priceAda: price,
      tokenA: tokenAUnit,
      tokenB: tokenBUnit,
      lpToken: lpTokenUnit,
    };
  }
}
