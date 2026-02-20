import { Controller, Get, Query, Param } from '@nestjs/common';
import { ApiTags, ApiResponse } from '@nestjs/swagger';

import { ApiDoc } from '../../decorators/api-doc.decorator';

import { GetMarketsDto } from './dto/get-markets.dto';
import { MarketService } from './market.service';

import { GetMarketsResponse, MarketItem, MarketItemWithOHLCV } from '@/modules/market/dto/get-markets-response.dto';

@Controller('markets')
@ApiTags('Markets')
export class MarketController {
  constructor(private readonly marketService: MarketService) {}

  @Get()
  @ApiDoc({
    summary: 'Get markets with pagination, sorting and filtering',
    description: 'Returns paginated list of markets with optional sorting and filtering',
    status: 200,
  })
  @ApiResponse({ status: 200, description: 'Returns paginated markets' })
  async getMarkets(@Query() query: GetMarketsDto): Promise<GetMarketsResponse> {
    return this.marketService.getMarkets(query);
  }

  @Get(':id/ohlcv')
  @ApiDoc({
    summary: 'Get market by ID with OHLCV data',
    description:
      'Returns market data with vault information, statistics, and OHLCV (Open, High, Low, Close, Volume) data from Taptools API',
    status: 200,
  })
  @ApiResponse({ status: 200, description: 'Returns market data with OHLCV', type: Object })
  @ApiResponse({ status: 404, description: 'Market not found' })
  async getMarketByIdWithOHLCV(
    @Param('id') marketId: string,
    @Query('interval') interval?: string
  ): Promise<MarketItemWithOHLCV> {
    return this.marketService.getMarketByIdWithOHLCV(marketId, interval || '1h');
  }

  @Get(':id')
  @ApiDoc({
    summary: 'Get market by ID',
    description: 'Returns market data with vault information and statistics. The ID parameter is the vault_id.',
    status: 200,
  })
  @ApiResponse({ status: 200, description: 'Returns market data', type: Object })
  @ApiResponse({ status: 404, description: 'Market not found' })
  async getMarketById(@Param('id') marketId: string): Promise<MarketItem> {
    return this.marketService.getMarketById(marketId);
  }
}
