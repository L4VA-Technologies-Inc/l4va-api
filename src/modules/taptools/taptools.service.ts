import { Injectable, HttpException, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import axios from 'axios';
import NodeCache from 'node-cache';
import { Repository } from 'typeorm';

import { AssetsService } from '../vaults/processing-tx/assets/assets.service';
import { VaultAssetsSummaryDto } from '../vaults/processing-tx/offchain-tx/dto/vault-assets-summary.dto';

import { AssetValueDto } from './dto/asset-value.dto';
import { WalletSummaryDto } from './dto/wallet-summary.dto';

import { Vault } from '@/database/vault.entity';
import { AssetOriginType, AssetStatus, AssetType } from '@/types/asset.types';

@Injectable()
export class TaptoolsService {
  private readonly logger = new Logger(TaptoolsService.name);

  private readonly baseUrl = 'https://openapi.taptools.io/api/v1';
  private readonly blockfrostTestnetUrl = 'https://cardano-preprod.blockfrost.io/api/v0/';
  private cache = new NodeCache({ stdTTL: 540 }); // cache for 540 seconds to reduce API calls for ADA price (9 minutes)
  private readonly taptoolsApiKey: string;

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    private readonly assetsService: AssetsService
  ) {
    this.taptoolsApiKey = process.env.TAPTOOLS_API_KEY || '';
  }

  private isTestnetAddress(address: string): boolean {
    return address.startsWith('addr_test');
  }

  async getAdaPrice(): Promise<number> {
    const cacheKey = 'ada_price_usd';
    const cachedPrice = this.cache.get<number>(cacheKey);
    if (cachedPrice !== undefined) return cachedPrice;

    try {
      const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
        params: {
          ids: 'cardano',
          vs_currencies: 'usd',
        },
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
    const totalAda = res.data.adaValue || 0;
    const totalUsd = totalAda * adaPriceUsd;

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
      },
    };
  }

  private async getAssetDetails(assetId: string): Promise<any> {
    try {
      const response = await axios.get(`${this.blockfrostTestnetUrl}/assets/${assetId}`, {
        headers: {
          project_id: process.env.BLOCKFROST_TESTNET_API_KEY,
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
      await axios.get(`${this.blockfrostTestnetUrl}addresses/${walletAddress}`, {
        headers: {
          project_id: process.env.BLOCKFROST_TESTNET_API_KEY,
        },
      });
    } catch (err) {
      this.logger.log('Error ', err);
      return {
        wallet: '',
        assets: [],
        totalValueAda: 0,
        totalValueUsd: 0,
        lastUpdated: '',
        summary: {
          totalAssets: 0,
          nfts: 0,
          tokens: 0,
          ada: 0,
        },
      };
    }
    try {
      // Get all assets in the wallet
      const assetsResponse = await axios.get(`${this.blockfrostTestnetUrl}addresses/${walletAddress}/total`, {
        headers: {
          project_id: process.env.BLOCKFROST_TESTNET_API_KEY,
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
        const batchPromises = batch.map(async asset => {
          try {
            // Get asset details
            const assetDetails = await axios.get(`${this.blockfrostTestnetUrl}assets/${asset.unit}`, {
              headers: {
                project_id: process.env.BLOCKFROST_TESTNET_API_KEY,
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
        },
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

  /**
   * Get the value of an asset in ADA and USD
   * @param policyId The policy ID of the asset
   * @param assetName The asset name (hex encoded)
   * @returns Promise with the asset value in ADA and USD
   */
  async getAssetValue(policyId: string, assetName: string): Promise<{ priceAda: number; priceUsd: number }> {
    try {
      const adaPrice = await this.getAdaPrice();

      // Hardcoded testnet policy IDs and their prices
      const testnetPrices: Record<string, number> = {
        f61a534fd4484b4b58d5ff18cb77cfc9e74ad084a18c0409321c811a: 0.00526,
        ed8145e0a4b8b54967e8f7700a5ee660196533ded8a55db620cc6a37: 0.00374,
        '755457ffd6fffe7b20b384d002be85b54a0b3820181f19c5f9032c2e': 250.0,
        fd948c7248ecef7654f77a0264a188dccc76bae5b73415fc51824cf3: 19000.0,
        add6529cc60380af5d51566e32925287b5b04328332652ccac8de0a9: 36.0,
        '4e529151fe66164ebcf52f81033eb0ec55cc012cb6c436104b30fa36': 69.0,
        '0b89a746fd2d859e0b898544487c17d9ac94b187ea4c74fd0bfbab16': 3400.0,
        '436ca2e51fa2887fa306e8f6aa0c8bda313dd5882202e21ae2972ac8': 115.93,
        '0d27d4483fc9e684193466d11bc6d90a0ff1ab10a12725462197188a': 188.57,
        '53173a3d7ae0a0015163cc55f9f1c300c7eab74da26ed9af8c052646': 100000.0,
        '91918871f0baf335d32be00af3f0604a324b2e0728d8623c0d6e2601': 250000.0,
      };

      if (testnetPrices[policyId]) {
        const hardcodedPriceAda = testnetPrices[policyId];
        return {
          priceAda: hardcodedPriceAda,
          priceUsd: hardcodedPriceAda * adaPrice,
        };
      }

      const cacheKey = `asset_value_${policyId}_${assetName}`;
      const cached = this.cache.get<{ priceAda: number; priceUsd: number }>(cacheKey);

      if (cached) return cached;

      const response = await axios.get(`${this.baseUrl}/token/price`, {
        headers: {
          'x-api-key': this.taptoolsApiKey,
        },
        params: {
          policy: policyId,
          name: assetName,
          currency: 'usd,ada',
        },
      });

      if (!response.data?.data) {
        throw new Error('Invalid response from TapTools API');
      }

      const result = {
        priceAda: Number(response.data.data.ada) || 91,
        priceUsd: Number(response.data.data.usd) || 91 * adaPrice,
      };

      this.cache.set(cacheKey, result);
      return result;
    } catch (error) {
      // No value on Preprod
      // console.error(`Error fetching asset value for ${policyId}.${assetName}:`, error.message);
      // Return zero values if the asset is not found or there's an error
      const adaPrice = await this.getAdaPrice();
      return { priceAda: 91, priceUsd: 91 * adaPrice };
    }
  }

  /**
   * Calculate the total value of all assets in a vault
   * @param vaultId The ID of the vault
   * @param phase The phase to filter assets by - 'contribute' for contributed assets, 'acquire' for invested assets
   * @returns Promise with the vault assets summary
   */
  async calculateVaultAssetsValue(
    vaultId: string,
    phase: 'contribute' | 'acquire' = 'contribute',
    updatePrices: boolean = true
  ): Promise<VaultAssetsSummaryDto> {
    // Get the vault to verify it exists
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      relations: ['assets'],
    });

    if (!vault) {
      throw new NotFoundException(`Vault with ID ${vaultId} not found`);
    }

    // Group assets by policyId and assetId to handle quantities
    const assetMap = new Map<
      string,
      {
        policyId: string;
        assetId: string;
        quantity: number;
        isNft: boolean;
        metadata?: Record<string, any>;
      }
    >();

    let totalAcquiredAda = 0;

    // Process each asset in the vault
    for (const asset of vault.assets) {
      // Skip assets that are not in a valid status for valuation or don't match the phase
      if (asset.status !== AssetStatus.PENDING && asset.status !== AssetStatus.LOCKED) {
        continue;
      }

      if (asset.origin_type === AssetOriginType.ACQUIRED && asset.policy_id === 'lovelace') {
        totalAcquiredAda += Number(asset.quantity);
      }

      // Filter assets based on phase
      if (
        (phase === 'contribute' && asset.origin_type !== AssetOriginType.CONTRIBUTED) ||
        (phase === 'acquire' && asset.origin_type !== AssetOriginType.ACQUIRED)
      ) {
        continue;
      }

      const key = `${asset.policy_id}_${asset.asset_id}`;
      const existingAsset = assetMap.get(key);

      if (existingAsset) {
        if (asset.type === AssetType.NFT) {
          existingAsset.quantity += 1;
        } else {
          existingAsset.quantity += Number(asset.quantity);
        }
      } else {
        assetMap.set(key, {
          policyId: asset.policy_id,
          assetId: asset.asset_id,
          quantity: asset.type === AssetType.NFT ? 1 : Number(asset.quantity),
          isNft: asset.type === AssetType.NFT,
          metadata: asset.metadata || {},
        });
      }
    }

    // Convert map to array for processing
    const assets = Array.from(assetMap.values());

    // Get asset values from TapTools
    const assetsWithValues = [];
    let totalValueAda = 0;
    let totalValueUsd = 0;

    for (const asset of assets) {
      try {
        // TODO: Test this
        if (asset.assetId === 'lovelace') {
          // Special case for ADA

          const adaPrice = await this.getAdaPrice();
          const totalAdaValue = asset.quantity * 1e-6; // Convert lovelace to ADA

          assetsWithValues.push({
            ...asset,
            assetName: 'ADA',
            valueAda: totalAdaValue,
            valueUsd: totalAdaValue * adaPrice,
          });
          totalValueAda += totalAdaValue;
          totalValueUsd += totalAdaValue * adaPrice;
          continue;
        }
        // Get asset value in ADA
        const assetValue = await this.getAssetValue(asset.policyId, asset.assetId);

        const valueAda = assetValue?.priceAda || 0;
        const valueUsd = assetValue?.priceUsd || 0;

        // Calculate total value for this asset
        const totalAssetValueAda = valueAda * asset.quantity;
        const totalAssetValueUsd = valueUsd * asset.quantity;

        assetsWithValues.push({
          ...asset,
          assetName: asset.assetId, // Using assetId as assetName for backward compatibility
          valueAda: totalAssetValueAda,
          valueUsd: totalAssetValueUsd,
        });

        totalValueAda += totalAssetValueAda;
        totalValueUsd += totalAssetValueUsd;
      } catch (error) {
        // Skip assets that can't be valued
        console.warn(`Could not value asset ${asset.policyId}.${asset.assetId}:`, error.message);
      }
    }

    if (updatePrices && assetsWithValues.length > 0) {
      await this.assetsService.updateAssetValuations(
        assetsWithValues.map(asset => ({
          policyId: asset.policyId,
          assetId: asset.assetId,
          valueAda: asset.valueAda / asset.quantity, // Get per-unit price
          isNft: asset.isNft,
        }))
      );
    }

    const adaPrice = await this.getAdaPrice();

    // Create and return the summary
    const summary: VaultAssetsSummaryDto = {
      totalValueAda: +totalValueAda.toFixed(6),
      totalValueUsd: +totalValueUsd.toFixed(2),
      totalAssets: assetsWithValues.length,
      nfts: assetsWithValues.filter(a => a.isNft).length,
      tokens: assetsWithValues.filter(a => !a.isNft).length,
      lastUpdated: new Date().toISOString(),
      totalAcquiredAda,
      totalAcquiredUsd: totalAcquiredAda * adaPrice,
      adaPrice,
      assets: assetsWithValues.map(asset => ({
        policyId: asset.policyId,
        assetName: asset.assetId, // Using assetId as assetName for backward compatibility
        quantity: asset.quantity,
        valueAda: asset.valueAda,
        valueUsd: asset.valueUsd,
        isNft: asset.isNft,
        metadata: asset.metadata,
      })),
    };

    return summary;
  }
}
