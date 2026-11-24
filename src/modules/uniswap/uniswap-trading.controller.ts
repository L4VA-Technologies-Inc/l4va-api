import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ApiDoc } from '../../decorators/api-doc.decorator';

import { UniswapTradingService } from './uniswap-trading.service';

@Controller('uniswap')
@ApiTags('Uniswap')
export class UniswapTradingController {
  constructor(private readonly uniswapTradingService: UniswapTradingService) {}

  @Get('config')
  @ApiDoc({
    summary: 'Public Uniswap Trading API config for Robinhood swaps',
    description: 'Chain id, native token, fee presence — no secrets',
    status: 200,
  })
  getConfig() {
    return this.uniswapTradingService.getConfig();
  }

  @Post('quote')
  @ApiDoc({
    summary: 'Proxy Uniswap Trading API /quote (Robinhood Chain)',
    description:
      'Server attaches UNISWAP_API_KEY + optional integratorFees. See https://developers.uniswap.org/docs/trading/swapping-api/start-building/integration-guide',
    status: 200,
  })
  quote(
    @Body()
    body: {
      tokenIn: string;
      tokenOut: string;
      amount: string;
      swapper: string;
      type?: 'EXACT_INPUT' | 'EXACT_OUTPUT';
      slippageTolerance?: number;
      protocols?: string[];
      permitAmount?: 'FULL' | 'EXACT';
      skipIntegratorFee?: boolean;
    }
  ) {
    return this.uniswapTradingService.quote(body);
  }

  @Post('check-approval')
  @ApiDoc({
    summary: 'Proxy Uniswap Trading API /check_approval',
    description: 'Returns an approval TransactionRequest when Permit2 allowance is missing',
    status: 200,
  })
  checkApproval(
    @Body()
    body: {
      walletAddress: string;
      token: string;
      amount: string;
      tokenOut?: string;
    }
  ) {
    return this.uniswapTradingService.checkApproval(body);
  }

  @Post('swap')
  @ApiDoc({
    summary: 'Proxy Uniswap Trading API /swap (CLASSIC / WRAP / UNWRAP)',
    description: 'Builds unsigned AMM swap calldata from a prior /quote response',
    status: 200,
  })
  swap(
    @Body()
    body: {
      quote: unknown;
      signature?: string;
      permitData?: unknown;
      refreshGasPrice?: boolean;
      simulateTransaction?: boolean;
    }
  ) {
    return this.uniswapTradingService.swap(body);
  }

  @Post('order')
  @ApiDoc({
    summary: 'Proxy Uniswap Trading API /order (UniswapX DUTCH_V3 / PRIORITY)',
    description: 'Submits a signed UniswapX Dutch/Priority order',
    status: 200,
  })
  order(
    @Body()
    body: {
      quote: unknown;
      signature: string;
      routing: string;
    }
  ) {
    return this.uniswapTradingService.order(body);
  }
}
