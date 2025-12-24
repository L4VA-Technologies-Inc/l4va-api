import { Controller, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

import { DexHunterService } from './dexhunter.service';
import { EstimateSwapResponse } from './dto/estimate-swap.dto';

interface EstimateSwapDto {
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  slippage?: number;
}

@ApiTags('dexhunter')
@Controller('dexhunter')
export class DexHunterController {
  constructor(private readonly dexHunterService: DexHunterService) {}

  @Post('estimate-swap')
  @ApiOperation({ summary: 'Estimate token swap using DexHunter' })
  @ApiResponse({
    status: 200,
    description: 'Swap estimation completed',
    schema: {
      properties: {
        averagePrice: { type: 'number' },
        netPrice: { type: 'number' },
        totalOutput: { type: 'number' },
        totalOutputWithoutSlippage: { type: 'number' },
        batcherFee: { type: 'number' },
        dexhunterFee: { type: 'number' },
        partnerFee: { type: 'number' },
        deposits: { type: 'number' },
        totalFee: { type: 'number' },
        splits: { type: 'array' },
      },
    },
  })
  async estimateSwap(@Body() body: EstimateSwapDto): Promise<EstimateSwapResponse> {
    return this.dexHunterService.estimateSwap(body);
  }
}
