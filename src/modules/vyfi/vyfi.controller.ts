import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiBody } from '@nestjs/swagger';

import { CreatePoolDto } from './dto/create-pool.dto';
import { VyfiService } from './vyfi.service';

@ApiTags('VyFi')
@Controller('vyfi')
export class VyfiController {
  constructor(private readonly vyfiService: VyfiService) {}

  @Get('check-pool')
  @ApiOperation({ summary: 'Check if a VyFi liquidity pool exists' })
  @ApiQuery({ name: 'networkId', required: true, type: Number })
  @ApiQuery({ name: 'tokenAUnit', required: true, type: String })
  @ApiQuery({ name: 'tokenBUnit', required: true, type: String })
  async checkPool(
    @Query('networkId') networkId: number,
    @Query('tokenAUnit') tokenAUnit: string,
    @Query('tokenBUnit') tokenBUnit: string
  ) {
    return this.vyfiService.checkPool({
      networkId,
      tokenAUnit,
      tokenBUnit,
    });
  }

  @Post('create-pool')
  @ApiOperation({ summary: 'Create a new VyFi liquidity pool' })
  // @ApiBody({ type: CreatePoolDto })
  async createLiquidityPool(@Body() body) {
    return this.vyfiService.createLiquidityPool(body);
  }

  @Get('pool/:poolId')
  @ApiOperation({ summary: 'Get VyFi pool information' })
  async getPoolInfo(@Query('poolId') poolId: string) {
    return this.vyfiService.getPoolInfo(poolId);
  }
}
