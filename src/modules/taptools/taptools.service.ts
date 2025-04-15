import { Injectable, HttpException } from '@nestjs/common';
import axios from 'axios';
import * as NodeCache from 'node-cache';
import { WalletSummaryDto } from './dto/wallet-summary.dto';
import { AssetValueDto } from './dto/asset-value.dto';

@Injectable()
export class TaptoolsService {
  private readonly baseUrl = 'https://openapi.taptools.io/api/v1';
  private readonly blockfrostTestnetUrl = 'https://cardano-preprod.blockfrost.io/api/v0/';
  private cache = new NodeCache({ stdTTL: 60 }); // cache for 60 seconds

  private isTestnetAddress(address: string): boolean {
    return address.startsWith('addr_test');
  }

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
      const adaPriceUsd = await this.getAdaPrice();

      let summary: WalletSummaryDto;

      if (this.isTestnetAddress(walletAddress)) {
        summary = await this.getTestnetWalletSummary(walletAddress, adaPriceUsd);
      } else {
        summary = await this.getMainnetWalletSummary(walletAddress, adaPriceUsd);
      }

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

  private async getMainnetWalletSummary(walletAddress: string, adaPriceUsd: number): Promise<WalletSummaryDto> {
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
          displayName: ft.ticker,
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
          displayName: nft.name,
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

    return {
      wallet: walletAddress,
      assets: processedAssets,
      totalValueAda: +totalAda.toFixed(4),
      totalValueUsd: +totalUsd.toFixed(4),
      lastUpdated: new Date().toISOString(),
      summary: {
        totalAssets: processedAssets.length,
        nfts: processedAssets.filter(a => a.isNft).length,
        tokens: processedAssets.filter(a => a.isFungibleToken).length,
        ada: totalAda,
      }
    };
  }

  private async getAssetDetails(assetId: string): Promise<any> {
    try {
      const response = await axios.get(`${this.blockfrostTestnetUrl}/assets/${assetId}`, {
        headers: {
          'project_id': process.env.BLOCKFROST_TESTNET_API_KEY,
        },
      });
      return response.data;
    } catch (err) {
      console.error(`Error fetching asset details for ${assetId}:`, err.message);
      return null;
    }
  }

  private async getTestnetWalletSummary(walletAddress: string, adaPriceUsd: number): Promise<WalletSummaryDto> {
    try {
      // Get all assets in the wallet
      const assetsResponse = await axios.get(`${this.blockfrostTestnetUrl}addresses/${walletAddress}/total`, {
        headers: {
          'project_id': process.env.BLOCKFROST_TESTNET_API_KEY,
        },
      });

      const processedAssets: AssetValueDto[] = [];
      
      // Calculate actual balances from received_sum and sent_sum
      const balances = new Map<string, number>();
      
      // Process received amounts
      assetsResponse.data.received_sum.forEach(asset => {
        balances.set(asset.unit, Number(asset.quantity));
      });

      // Subtract sent amounts
      assetsResponse.data.sent_sum.forEach(asset => {
        const currentBalance = balances.get(asset.unit) || 0;
        balances.set(asset.unit, currentBalance - Number(asset.quantity));
      });

      // Process ADA amount
      const totalAda = (balances.get('lovelace') || 0) / 1000000; // Convert lovelace to ADA
      const totalUsd = totalAda * adaPriceUsd;

      // Get detailed asset list for non-zero balances
      const nonAdaAssets = Array.from(balances.entries())
        .filter(([unit, balance]) => unit !== 'lovelace' && balance > 0)
        .map(([unit, balance]) => ({ unit, quantity: balance }));

      // Get asset details in batches to avoid rate limits
      const batchSize = 10;
      for (let i = 0; i < nonAdaAssets.length; i += batchSize) {
        const batch = nonAdaAssets.slice(i, i + batchSize);
        const batchPromises = batch.map(async (asset) => {
          try {
            // Get asset details
            const assetDetails = await axios.get(`${this.blockfrostTestnetUrl}assets/${asset.unit}`, {
              headers: {
                'project_id': process.env.BLOCKFROST_TESTNET_API_KEY,
              },
            });

            return {
              asset,
              details: assetDetails.data,
            };
          } catch (error) {
            console.error(`Error fetching details for asset ${asset.unit}:`, error.message);
            return null;
          }
        });

        const batchResults = await Promise.all(batchPromises);

        // Process batch results
        for (const result of batchResults) {
          if (!result) continue;
          const { asset, details } = result;
          const isNft = Number(asset.quantity) === 1;
          const metadata = details.onchain_metadata || details.metadata || {};

          let assetName = asset.unit;
          try {
            if (details.asset_name) {
              assetName = Buffer.from(details.asset_name, 'hex').toString('utf8');
            }
          } catch (error) {
            console.warn(`Could not decode asset name for ${asset.unit}`);
          }

          processedAssets.push({
            tokenId: asset.unit,
            name: assetName,
            displayName: metadata.name || undefined,
            ticker: details.ticker || undefined,
            quantity: Number(asset.quantity),
            isNft,
            isFungibleToken: !isNft,
            priceAda: 0,
            priceUsd: 0,
            valueAda: 0,
            valueUsd: 0,
            metadata: {
              policyId: details.policy_id,
              fingerprint: details.fingerprint,
              decimals: details.decimals || 0,
              description: metadata.description,
              image: metadata.image,
              mediaType: metadata.mediaType,
              files: details.onchain_metadata?.files || [],
              attributes: metadata.attributes || {},
              assetName: details.asset_name,
              mintTx: details.initial_mint_tx_hash,
              mintQuantity: details.quantity,
              onchainMetadata: details.onchain_metadata || {},
            },
          });
        }
      }

      const summary: WalletSummaryDto = {
        wallet: walletAddress,
        assets: processedAssets,
        totalValueAda: +totalAda.toFixed(4),
        totalValueUsd: +totalUsd.toFixed(4),
        lastUpdated: new Date().toISOString(),
        summary: {
          totalAssets: processedAssets.length,
          nfts: processedAssets.filter(a => a.isNft).length,
          tokens: processedAssets.filter(a => a.isFungibleToken).length,
          ada: totalAda,
        }
      };

      return summary;

    } catch (err) {
      console.error('Error fetching testnet wallet summary:', err.message);
      if (axios.isAxiosError(err)) {
        throw new HttpException(
          err.response?.data?.message || 'Failed to fetch testnet wallet assets',
          err.response?.status || 500
        );
      }
      throw new HttpException('Failed to fetch or process testnet wallet assets', 500);
    }
  }
}
