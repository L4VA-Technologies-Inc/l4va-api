import { Injectable, HttpException } from '@nestjs/common';
import axios from 'axios';
import * as NodeCache from 'node-cache';
import { WalletSummaryDto } from './dto/wallet-summary.dto';
import { AssetValueDto } from './dto/asset-value.dto';

@Injectable()
export class TaptoolsService {
  private readonly baseUrl = 'https://openapi.taptools.io/api/v1';
  private cache = new NodeCache({ stdTTL: 60 }); // cache for 60 seconds

  private async getAdaPrice(): Promise<number> {
    const cacheKey = 'ada_price_usd';
    const cachedPrice = this.cache.get<number>(cacheKey);
    if (cachedPrice !== undefined) return cachedPrice;

    try {
      const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
        params: {
          ids: 'cardano',
          vs_currencies: 'usd'
        }
      });
      
      if (!response.data?.cardano?.usd) {
        throw new HttpException('Invalid price data from API', 400);
      }

      const adaPrice = Number(response.data.cardano.usd);
      this.cache.set(cacheKey, adaPrice);
      return adaPrice;
    } catch (err) {
      console.error('Error fetching ADA price:', err.message);
      throw new HttpException('Failed to fetch ADA price', 500);
    }
  }

  async getWalletSummary(walletAddress: string): Promise<WalletSummaryDto> {
    const cacheKey = `wallet_summary_${walletAddress}`;
    const cached = this.cache.get<WalletSummaryDto>(cacheKey);
    if (cached) return cached;
  
    try {
      // Get ADA price first
      const adaPriceUsd = await this.getAdaPrice();

      const res = await axios.get(`${this.baseUrl}/wallet/portfolio/positions?address=${walletAddress}`, {
        headers: {
          'x-api-key': process.env.TAPTOOLS_API_KEY,
        },
        timeout: 15000,
      });
  
      if (!res.data) {
        throw new HttpException('Invalid response format from API', 400);
      }
  
      const processedAssets: AssetValueDto[] = [];
      let totalAda = res.data.adaValue || 0;
      let totalUsd = totalAda * adaPriceUsd;
  
      // Process fungible tokens
      if (res.data.positionsFt) {
        for (const ft of res.data.positionsFt) {
          processedAssets.push({
            tokenId: ft.unit,
            name: ft.ticker,
            quantity: ft.balance,
            isNft: false,
            isFungibleToken: true,
            priceAda: ft.price,
            priceUsd: ft.price * adaPriceUsd,
            valueAda: ft.adaValue,
            valueUsd: ft.adaValue * adaPriceUsd,
          });
        }
      }
  
      // Process NFTs
      if (res.data.positionsNft) {
        for (const nft of res.data.positionsNft) {
          processedAssets.push({
            tokenId: nft.policy,
            name: nft.name,
            quantity: nft.balance,
            isNft: true,
            isFungibleToken: false,
            priceAda: nft.floorPrice,
            priceUsd: nft.floorPrice * adaPriceUsd,
            valueAda: nft.adaValue,
            valueUsd: nft.adaValue * adaPriceUsd,
          });
        }
      }
  
  
      const summary: WalletSummaryDto = {
        wallet: walletAddress,
        assets: processedAssets,
        totalValueAda: +totalAda.toFixed(4),
        totalValueUsd: +totalUsd.toFixed(4),
        lastUpdated: new Date().toISOString(),
      };
  
      this.cache.set(cacheKey, summary);
      return summary;
  
    } catch (err) {
      console.error('Error fetching wallet summary:', err.message);
      if (axios.isAxiosError(err)) {
        throw new HttpException(
          err.response?.data?.message || 'Failed to fetch wallet assets',
          err.response?.status || 500
        );
      }
      throw new HttpException('Failed to fetch or process wallet assets', 500);
    }
  }
}
