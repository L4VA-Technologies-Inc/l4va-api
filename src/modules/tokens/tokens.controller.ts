import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';

import { ApiDoc } from '../../decorators/api-doc.decorator';

import { TokensService } from './tokens.service';

@Controller('tokens')
@ApiTags('Tokens')
export class TokensController {
  constructor(private readonly tokensService: TokensService) {}

  @Get('memecoins')
  @ApiDoc({
    summary: 'List curated memecoins with live CoinGecko market data',
    description: 'Returns seed memecoins enriched with price, mcap, volume, 24h change and sparkline',
    status: 200,
  })
  @ApiResponse({ status: 200, description: 'Memecoin list with live market data' })
  async getMemecoins() {
    return this.tokensService.getMemecoins();
  }

  @Get('cardano/memecoins')
  @ApiDoc({
    summary: 'List Cardano memecoins from DexHunter',
    description: 'Curated Cardano-native tokens enriched with live DexHunter ADA prices',
    status: 200,
  })
  async getCardanoMemecoins() {
    return this.tokensService.getCardanoMemecoins();
  }

  @Get('cardano/:id/ohlc')
  @ApiDoc({
    summary: 'Get OHLC candles for a Cardano token',
    description: 'DexHunter OHLCV converted to USD for VaultChart',
    status: 200,
  })
  async getCardanoMemecoinOhlc(@Param('id') id: string, @Query('days') days?: string) {
    const parsed = Number(days);
    const safeDays = [1, 7, 14, 30, 90, 180, 365].includes(parsed) ? parsed : 7;
    return this.tokensService.getCardanoMemecoinOhlc(id, safeDays);
  }

  @Get('cardano/:id')
  @ApiDoc({
    summary: 'Get a Cardano token by unit (policy+asset hex)',
    description: 'DexHunter seed + live price',
    status: 200,
  })
  @ApiResponse({ status: 404, description: 'Token not found' })
  async getCardanoMemecoin(@Param('id') id: string) {
    return this.tokensService.getCardanoMemecoin(id);
  }

  @Get('robinhood/memecoins')
  @ApiDoc({
    summary: 'List Robinhood-chain memecoins',
    description: 'Seed list enriched with live DexScreener price/volume/liquidity',
    status: 200,
  })
  async getRobinhoodMemecoins() {
    return this.tokensService.getRobinhoodMemecoins();
  }

  @Get('robinhood/rwas')
  @ApiDoc({
    summary: 'List Robinhood RWA / stock tokens',
    description: 'Seed RWA list enriched with live DexScreener market data when available',
    status: 200,
  })
  async getRobinhoodRwas() {
    return this.tokensService.getRobinhoodRwas();
  }

  @Get('robinhood/nfts')
  @ApiDoc({
    summary: 'List Robinhood-chain NFT collections',
    description: 'Top NFT collections by holder count from Blockscout seed (no live price)',
    status: 200,
  })
  async getRobinhoodNfts() {
    return this.tokensService.getRobinhoodNfts();
  }

  @Get('robinhood/:address/ohlc')
  @ApiDoc({
    summary: 'Get OHLC candles for a Robinhood-chain token',
    description: 'Resolves DexScreener pair then fetches GeckoTerminal OHLCV for the pool',
    status: 200,
  })
  async getRobinhoodTokenOhlc(@Param('address') address: string, @Query('days') days?: string) {
    const parsed = Number(days);
    const safeDays = [1, 7, 14, 30, 90, 180, 365].includes(parsed) ? parsed : 7;
    return this.tokensService.getRobinhoodTokenOhlc(address, safeDays);
  }

  @Get('robinhood/:address/trades')
  @ApiDoc({
    summary: 'Get recent DEX trades for a Robinhood-chain token',
    description: 'Live pool trades from GeckoTerminal for the token’s primary DexScreener pair',
    status: 200,
  })
  async getRobinhoodTokenTrades(@Param('address') address: string, @Query('limit') limit?: string) {
    const parsed = Number(limit);
    const safeLimit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : 40;
    return this.tokensService.getRobinhoodTokenTrades(address, safeLimit);
  }

  @Get('robinhood/:address')
  @ApiDoc({
    summary: 'Get a Robinhood-chain token by contract address',
    description: 'Looks up memecoin, RWA, or NFT seed and returns enriched market data',
    status: 200,
  })
  @ApiResponse({ status: 404, description: 'Token not found' })
  async getRobinhoodToken(@Param('address') address: string) {
    return this.tokensService.getRobinhoodToken(address);
  }

  @Get('memecoins/:id')
  @ApiDoc({
    summary: 'Get a curated memecoin by CoinGecko id',
    description: 'Returns a single seed memecoin enriched with live CoinGecko market data',
    status: 200,
  })
  @ApiResponse({ status: 200, description: 'Memecoin with live market data' })
  @ApiResponse({ status: 404, description: 'Token not found' })
  async getMemecoin(@Param('id') id: string) {
    return this.tokensService.getMemecoin(id);
  }

  @Get('memecoins/:id/ohlc')
  @ApiDoc({
    summary: 'Get OHLC candles for a memecoin',
    description: 'CoinGecko OHLC mapped to { time, open, high, low, close }. days: 1, 7, 14, 30, 90, 180, 365',
    status: 200,
  })
  @ApiResponse({ status: 200, description: 'OHLC series' })
  async getMemecoinOhlc(@Param('id') id: string, @Query('days') days?: string) {
    const parsed = Number(days);
    const safeDays = [1, 7, 14, 30, 90, 180, 365].includes(parsed) ? parsed : 7;
    return this.tokensService.getMemecoinOhlc(id, safeDays);
  }
}
