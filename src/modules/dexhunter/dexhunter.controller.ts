import { Controller, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

import { DexHunterService, EstimateSwapResponse, ExecuteSwapResponse } from './dexhunter.service';

interface EstimateSwapDto {
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  slippage?: number;
}

interface ExecuteSwapDto {
  vaultId: string;
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

  @Post('execute-swap')
  @ApiOperation({ summary: 'Execute token swap using vault treasury wallet and DexHunter' })
  @ApiResponse({
    status: 200,
    description: 'Swap executed successfully',
    schema: {
      properties: {
        txHash: { type: 'string' },
        estimatedOutput: { type: 'number' },
        actualSlippage: { type: 'number' },
      },
    },
  })
  async executeSwap(@Body() body: ExecuteSwapDto): Promise<ExecuteSwapResponse> {
    return this.dexHunterService.executeSwap(body.vaultId, {
      tokenIn: body.tokenIn,
      tokenOut: body.tokenOut,
      amountIn: body.amountIn,
      slippage: body.slippage,
    });
  }
}
