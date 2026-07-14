import { Controller, UseGuards, Body, Post, Get, Param } from '@nestjs/common';
import { ApiBody, ApiResponse, ApiTags, ApiParam } from '@nestjs/swagger';

import { ApiDoc } from '../../decorators/api-doc.decorator';
import { AdminGuard } from '../auth/admin.guard';
import { AuthGuard } from '../auth/auth.guard';

import { PaginationQueryDto } from './dto/pagination.dto';
import { PaginatedWalletSummaryDto } from './dto/wallet-summary.dto';
import { TapToolsTokenPoolDto } from './interfaces/taptools.interface';
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

  @Get('pools/:tokenUnit')
  @ApiDoc({
    summary: 'Get token pool data',
    description: 'Returns LP pool data for a given token unit (policyId + assetName hex)',
    status: 200,
  })
  @ApiParam({
    name: 'tokenUnit',
    description: 'Token unit (policyId + assetName in hex format)',
    example:
      '4ce7b207481a9ed46e9e250c0bab32b6be8e56bcfab3c95abd591d24f6cee18b885e242e91e167e80a38543e58e6c6bd9a9af86e54d8ecef21c78948',
  })
  @ApiResponse({ status: 200, description: 'Array of pool data with LP token units and total supply' })
  @UseGuards(AdminGuard)
  async getTokenPools(@Param('tokenUnit') tokenUnit: string): Promise<TapToolsTokenPoolDto[]> {
    return this.taptoolsService.getTokenPools(tokenUnit);
  }

  @Get('price/:tokenUnit')
  @ApiDoc({
    summary: 'Get token price in ADA',
    description: 'Returns token price in ADA for a given token unit',
    status: 200,
  })
  @ApiParam({
    name: 'tokenUnit',
    description: 'Token unit (policyId + assetName in hex format)',
    example: '63efb704b7396890e4d9539d030c0e667739043add65c00f96c586c056616c6f72756d',
  })
  @ApiResponse({
    status: 200,
    description: 'Token price result in ADA',
    schema: {
      example: {
        tokenUnit: '63efb704b7396890e4d9539d030c0e667739043add65c00f96c586c056616c6f72756d',
        priceAda: 0.0184,
      },
    },
  })
  @UseGuards(AdminGuard)
  async getTokenPrice(@Param('tokenUnit') tokenUnit: string): Promise<{ tokenUnit: string; priceAda: number | null }> {
    return this.taptoolsService.getTokenPriceAda(tokenUnit);
  }
}
