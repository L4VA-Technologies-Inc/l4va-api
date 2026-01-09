import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

import { ApiDoc } from '../../decorators/api-doc.decorator';

import { GetMarketsDto } from './dto/get-markets.dto';
import { MarketService } from './market.service';

import { Market } from '@/database/market.entity';

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
  @ApiOperation({ summary: 'Get markets' })
  @ApiResponse({ status: 200, description: 'Returns paginated markets' })
  async getMarkets(@Query() query: GetMarketsDto): Promise<{
    items: Market[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    return this.marketService.getMarkets(query);
  }
}
