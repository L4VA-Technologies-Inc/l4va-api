import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { HttpException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import axios from 'axios';
import { plainToInstance } from 'class-transformer';
import NodeCache from 'node-cache';
import { In, Repository } from 'typeorm';
import { createPublicClient, defineChain, http, parseAbi, type Address } from 'viem';

import { DexHunterPricingService } from '../dexhunter/dexhunter-pricing.service';
import { VaultAssetsSummaryDto } from '../vaults/processing-tx/offchain-tx/dto/vault-assets-summary.dto';
import { VyfiService } from '../vyfi/vyfi.service';
import { WayUpPricingService } from '../wayup/wayup-pricing.service';

import { AssetValueDto, BlockfrostAssetResponseDto } from './dto/asset-value.dto';
import { BlockfrostAddressTotalDto } from './dto/blockfrost-address.dto';
import { PaginationMetaDto, PaginationQueryDto } from './dto/pagination.dto';
import { PaginatedWalletSummaryDto, WalletOverviewDto } from './dto/wallet-summary.dto';
import { TapToolsTokenPoolDto } from './interfaces/taptools.interface';
import { TapToolsClient } from './taptools.client';

import { Asset } from '@/database/asset.entity';
import { EvmAssetPriceFeedEntity } from '@/database/evmAssetPriceFeed.entity';
import { Snapshot } from '@/database/snapshot.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { AlertsService } from '@/modules/alerts/alerts.service';
import { SystemSettingsService } from '@/modules/globals/system-settings/system-settings.service';
import { PriceService } from '@/modules/price/price.service';
import { AssetsService } from '@/modules/vaults/assets/assets.service';
import { TreasuryWalletService } from '@/modules/vaults/treasure/treasure-wallet.service';
import { AssetOriginType, AssetStatus, AssetType, AssetValuationMethod } from '@/types/asset.types';
import {
  ChainType,
  VAULT_STATUSES_ACTIVE,
  VAULT_STATUSES_WITH_VT_TOKENS,
  VAULT_STATUSES_WITHOUT_VT_TOKENS,
  VaultStatus,
} from '@/types/vault.types';
import { normalizeAssetImageSource } from '@/utils/asset-image-source.util';

// ---------------------------------------------------------------------------
// EVM ABI fragments used for wallet asset enumeration
// ---------------------------------------------------------------------------
const ERC165_ABI = parseAbi(['function supportsInterface(bytes4 interfaceId) view returns (bool)']);

const ERC20_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
]);

const ERC721_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function tokenURI(uint256 tokenId) view returns (string)',
]);

const ERC1155_ABI = parseAbi([
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function uri(uint256 id) view returns (string)',
]);

// ERC-165 interface IDs
const ERC721_INTERFACE_ID = '0x80ac58cd' as const;
const ERC1155_INTERFACE_ID = '0xd9b67a26' as const;

// Transfer event topic0 values for token enumeration
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const ERC721_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;
const ERC1155_TRANSFER_SINGLE_TOPIC = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62' as const;
const ERC1155_TRANSFER_BATCH_TOPIC = '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb' as const;

// Chainlink AggregatorV3Interface — used to read on-chain price feeds on Robinhood mainnet
const CHAINLINK_AGGREGATOR_ABI = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
]);

/** Map of policyId/contractAddress -> custom price in ADA for vault-specific asset valuations */
export type CustomPriceMap = Map<string, number>;

/** Per-feed configuration loaded from evm_asset_price_feeds */
export type EvmPriceFeedConfig = {
  feedAddress: string;
  maxAgeSeconds: number;
  allowDexscreenerFallback: boolean;
};

/** Map of token contract address (lowercase) -> feed configuration */
export type EvmPriceFeedsMap = Map<string, EvmPriceFeedConfig>;

interface GetAssetValueParams {
  policyId: string;
  assetName: string;
  isNFT: boolean;
  /** Optional custom price map for vault-specific overrides */
  customPriceMap?: CustomPriceMap;
  /** Optional readable name for trait-based pricing (e.g., Relics of Magma) */
  name?: string;
  /** Optional asset entity ID for caching trait metadata */
  assetEntityId?: string;
}

interface AssetPriceResult {
  priceAda: number;
  priceUsd: number;
}

interface TokenPriceResult {
  tokenUnit: string;
  priceAda: number | null;
}

@Injectable()
export class TaptoolsService {
  private readonly logger = new Logger(TaptoolsService.name);

  private readonly isMainnet: boolean;
  private readonly priceDeviationProtectionEnabled: boolean;
  private cache = new NodeCache({ stdTTL: 600 }); // cache for 10 minutes to reduce API calls for ADA price
  private readonly blockfrost: BlockFrostAPI;
  private assetDetailsCache = new NodeCache({ stdTTL: 3600, checkperiod: 300 });
  private walletUnitsCache = new NodeCache({ stdTTL: 60 }); // cache for 1 minute for wallet asset units
  private relicsTraitPriceCache = new NodeCache({ stdTTL: 900, checkperiod: 120 }); // cache for 15 minutes for trait prices

  // Relics of Magma trait-based pricing configuration
  private readonly RELICS_OF_MAGMA_VITA_POLICY = '94ec588251e710b7660dfd7765f08c87742a3012cce802897a3ebd28';
  private readonly RELICS_OF_MAGMA_PORTA_POLICY = '14296258677a869366d6bb01568f31f7b2e690208739b7bcdca444b2';
  private readonly CNFT_TOOLS_VITA_TRAIT_FLOORS_URL = 'https://cnft.tools/toolsapi/v3/traitfloors/romtv';
  // Fallback prices if CNFT.tools API fails
  private readonly RELICS_CHARACTER_PRICES_FALLBACK = {
    Exploratur: 300, // 300 ADA
    Phoenix: 200, // 200 ADA
    Balaena: 140, // 140 ADA
  };
  private readonly RELICS_PORTA_PRICE_FALLBACK = 70; // 70 ADA for all Porta NFTs - fallback
  private readonly testnetPrices = {
    // Policy-level prices (fallback when no asset-specific price exists)
    f61a534fd4484b4b58d5ff18cb77cfc9e74ad084a18c0409321c811a: 0.00526,
    ed8145e0a4b8b54967e8f7700a5ee660196533ded8a55db620cc6a37: 0.00374,
    '755457ffd6fffe7b20b384d002be85b54a0b3820181f19c5f9032c2e': 250.0,
    fd948c7248ecef7654f77a0264a188dccc76bae5b73415fc51824cf3: 15000.0,
    add6529cc60380af5d51566e32925287b5b04328332652ccac8de0a9: 36.0,
    '4e529151fe66164ebcf52f81033eb0ec55cc012cb6c436104b30fa36': 69.0,
    '0b89a746fd2d859e0b898544487c17d9ac94b187ea4c74fd0bfbab16': 3400.0,
    '436ca2e51fa2887fa306e8f6aa0c8bda313dd5882202e21ae2972ac8': 115.93,
    '0d27d4483fc9e684193466d11bc6d90a0ff1ab10a12725462197188a': 188.57,
    '53173a3d7ae0a0015163cc55f9f1c300c7eab74da26ed9af8c052646': 100000.0,
    '91918871f0baf335d32be00af3f0604a324b2e0728d8623c0d6e2601': 250000.0,

    // Asset-specific prices (policyId + assetName) - for testing multiple multipliers
    // Example: Different prices for individual NFTs within the same policy
    '0b89a746fd2d859e0b898544487c17d9ac94b187ea4c74fd0bfbab16526f6d616e2330303031': 3400.0,
    '0b89a746fd2d859e0b898544487c17d9ac94b187ea4c74fd0bfbab16526f6d616e2330303032': 3500.0,
    '0b89a746fd2d859e0b898544487c17d9ac94b187ea4c74fd0bfbab16526f6d616e2330303033': 3600.0,
    '0b89a746fd2d859e0b898544487c17d9ac94b187ea4c74fd0bfbab16526f6d616e2330303034': 3700.0,
    '0b89a746fd2d859e0b898544487c17d9ac94b187ea4c74fd0bfbab16526f6d616e2330303035': 3800.0,
    '436ca2e51fa2887fa306e8f6aa0c8bda313dd5882202e21ae2972ac8546573744e46543031': 115.93,
    '436ca2e51fa2887fa306e8f6aa0c8bda313dd5882202e21ae2972ac8546573744e46543032': 120.5,
    '436ca2e51fa2887fa306e8f6aa0c8bda313dd5882202e21ae2972ac8546573744e46543033': 125.75,
    '436ca2e51fa2887fa306e8f6aa0c8bda313dd5882202e21ae2972ac8546573744e46543034': 130.25,
    '436ca2e51fa2887fa306e8f6aa0c8bda313dd5882202e21ae2972ac8546573744e46543035': 135,
  };

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    @InjectRepository(Snapshot)
    private readonly snapshotRepository: Repository<Snapshot>,
    @InjectRepository(EvmAssetPriceFeedEntity)
    private readonly evmPriceFeedRepository: Repository<EvmAssetPriceFeedEntity>,
    private readonly assetsService: AssetsService,
    private readonly priceService: PriceService,
    private readonly configService: ConfigService,
    private readonly systemSettingsService: SystemSettingsService,
    private readonly dexHunterPricingService: DexHunterPricingService,
    private readonly wayUpPricingService: WayUpPricingService,
    private readonly alertsService: AlertsService,
    private readonly tapToolsClient: TapToolsClient,
    private readonly vyfiService: VyfiService,
    @Optional() @Inject('TreasuryWalletService') private readonly treasuryWalletService?: TreasuryWalletService
  ) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    this.priceDeviationProtectionEnabled = this.getDeviationProtectionEnabled();

    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });
  }

  private getDeviationThresholdPercentByClass(isNFT: boolean): number {
    return isNFT
      ? this.systemSettingsService.priceMaxDeviationPercentNft
      : this.systemSettingsService.priceMaxDeviationPercentFt;
  }

  private getMinAbsolutePriceMoveAda(): number {
    return this.systemSettingsService.priceMinAbsoluteMoveAda;
  }

  private getDeviationProtectionEnabled(): boolean {
    const configuredValue = this.configService.get<boolean | string>('PRICE_DEVIATION_PROTECTION_ENABLED');
    if (typeof configuredValue === 'boolean') {
      return configuredValue;
    }

    if (typeof configuredValue === 'string') {
      return ['1', 'true', 'yes', 'on'].includes(configuredValue.toLowerCase());
    }

    return true;
  }

  private async shouldAcceptPriceUpdate(params: {
    policyId: string;
    assetId: string;
    isNFT: boolean;
    previousPrice?: number | null;
    nextPrice: number;
    source: 'custom' | 'testnet' | 'api';
  }): Promise<{
    accepted: boolean;
    rejectionReason?: {
      policyId: string;
      assetId: string;
      assetClass: 'NFT' | 'FT';
      source: string;
      direction: 'up' | 'down';
      previousPrice: number;
      nextPrice: number;
      absoluteMoveAda: number;
      minAbsoluteMoveAda: number;
      deviationPercent: number;
      thresholdPercent: number;
    };
  }> {
    const { policyId, assetId, isNFT, previousPrice, nextPrice, source } = params;

    // Custom/testnet values are intentional overrides and should not be blocked.
    if (!this.priceDeviationProtectionEnabled || source !== 'api') {
      return { accepted: true };
    }

    if (previousPrice === null || previousPrice === undefined || previousPrice <= 0 || nextPrice <= 0) {
      return { accepted: true };
    }

    const minAssetPriceForDeviationCheckAda = this.systemSettingsService.priceMinAssetPriceForDeviationCheckAda;
    if (previousPrice < minAssetPriceForDeviationCheckAda && nextPrice < minAssetPriceForDeviationCheckAda) {
      return { accepted: true };
    }

    const absoluteMoveAda = Math.abs(nextPrice - previousPrice);
    const minAbsoluteMoveAda = this.getMinAbsolutePriceMoveAda();
    if (absoluteMoveAda < minAbsoluteMoveAda) {
      return { accepted: true };
    }

    const thresholdPercent = this.getDeviationThresholdPercentByClass(isNFT);

    const deviationPercent = Math.abs(((nextPrice - previousPrice) / previousPrice) * 100);
    if (deviationPercent <= thresholdPercent) {
      return { accepted: true };
    }

    const assetClass = isNFT ? 'NFT' : 'FT';
    const direction = nextPrice > previousPrice ? 'up' : 'down';

    this.logger.error(
      `[MANUAL_REVIEW_REQUIRED] ${assetClass} price update rejected for ${policyId}.${assetId}. ` +
        `Deviation ${deviationPercent.toFixed(2)}% (${direction}) exceeds threshold ±${thresholdPercent}% ` +
        `(prev=${previousPrice}, next=${nextPrice}, source=${source}).`
    );

    return {
      accepted: false,
      rejectionReason: {
        policyId,
        assetId,
        assetClass,
        source,
        direction,
        previousPrice,
        nextPrice,
        absoluteMoveAda: Number(absoluteMoveAda.toFixed(8)),
        minAbsoluteMoveAda,
        deviationPercent: Number(deviationPercent.toFixed(4)),
        thresholdPercent,
      },
    };
  }

  private calculateBalances(data: BlockfrostAddressTotalDto): Map<string, number> {
    const balances = new Map<string, number>();

    // Process received amounts
    data.received_sum?.forEach(asset => {
      balances.set(asset.unit, Number(asset.quantity));
    });

    // Subtract sent amounts
    data.sent_sum?.forEach(asset => {
      const currentBalance = balances.get(asset.unit) || 0;
      balances.set(asset.unit, currentBalance - Number(asset.quantity));
    });

    return balances;
  }

  private async fetchAssetDetailsFromApi(assetId: string): Promise<{
    details: BlockfrostAssetResponseDto;
    cached?: boolean;
  } | null> {
    // Check cache first
    const cacheKey = `asset_details_${assetId}`;
    const cached = this.assetDetailsCache.get<BlockfrostAssetResponseDto>(cacheKey);

    if (cached) {
      return { details: cached, cached: true };
    }

    try {
      const assetDetails = await this.blockfrost.assetsById(assetId);

      // Cache successful response
      this.assetDetailsCache.set(cacheKey, assetDetails as BlockfrostAssetResponseDto);

      return { details: assetDetails as BlockfrostAssetResponseDto, cached: false };
    } catch (error: any) {
      this.logger.debug(`Failed to fetch details for asset ${assetId}: ${error.message}`);
      return null;
    }
  }

  private decodeAssetName(hexName: string): string {
    try {
      if (!hexName) return 'Unknown Asset';

      // Decode hex to buffer
      const buffer = Buffer.from(hexName, 'hex');
      const decoded = buffer.toString('utf8');

      // Validate UTF-8: check for replacement characters
      if (decoded.includes('\uFFFD')) {
        // Contains replacement character - not valid UTF-8
        return hexName;
      }

      // Validate round-trip: re-encode and compare
      const reEncoded = Buffer.from(decoded, 'utf8').toString('hex');
      if (reEncoded.toLowerCase() !== hexName.toLowerCase()) {
        // Round-trip failed - not valid UTF-8
        return hexName;
      }

      // Valid UTF-8 string
      return decoded;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error: any) {
      return hexName || 'Unknown Asset';
    }
  }

  /**
   * Extract character trait from NFT metadata for Relics of Magma collections
   * @param metadata The NFT metadata object
   * @returns Character trait value or null if not found
   */
  private extractCharacterTrait(metadata: any): string | null {
    if (!metadata || typeof metadata !== 'object') return null;

    // Check top-level keys first  (WayUp API format: "attributes / Character")
    const characterKeys = ['attributes / Character', 'Character', 'character'];

    for (const key of characterKeys) {
      if (metadata[key]) {
        return metadata[key];
      }
    }

    // Check if attributes is an object (nested structure)
    if (metadata.attributes && typeof metadata.attributes === 'object' && !Array.isArray(metadata.attributes)) {
      // Check nested attributes keys
      const nestedKeys = ['attributes / Character', 'Character', 'character'];
      for (const key of nestedKeys) {
        if (metadata.attributes[key]) {
          return metadata.attributes[key];
        }
      }
    }

    // Check if attributes is an array (CIP-25 standard)
    if (Array.isArray(metadata.attributes)) {
      const characterAttr = metadata.attributes.find(
        (attr: any) => attr.trait_type === 'Character' || attr.name === 'Character'
      );
      if (characterAttr) {
        return characterAttr.value;
      }
    }

    this.logger.debug(`Character trait not found in metadata`);
    return null;
  }

  /**
   * Fetch Relics of Magma Vita trait floor prices from CNFT.tools API
   * @returns Map of character -> price in ADA, or null if fetch fails
   */
  private async fetchRelicsVitaTraitPricesFromCNFT(): Promise<Map<string, number> | null> {
    // Check cache first
    const cacheKey = 'relics_vita_trait_prices';
    const cached = this.relicsTraitPriceCache.get<Map<string, number>>(cacheKey);

    if (cached) {
      return cached;
    }

    // Only works on mainnet
    if (!this.isMainnet) {
      return null;
    }

    try {
      const response = await axios.get(this.CNFT_TOOLS_VITA_TRAIT_FLOORS_URL, {
        timeout: 5000,
      });

      if (response.data && response.data.Character) {
        const traitPrices = new Map<string, number>();
        const characterData = response.data.Character;

        // Extract floor prices from the array structure
        // Format: { "Exploratur": [total_count, on_market, percentage, ..., ..., listing_object], ... }
        // Index [0] = total count, Index [1] = on market, Index [8] = cheapest listing object with "price" in lovelace
        for (const [character, data] of Object.entries(characterData)) {
          if (Array.isArray(data) && data.length > 8 && typeof data[8] === 'object' && data[8] !== null) {
            const listingObject = data[8] as any;
            if (listingObject.price && typeof listingObject.price === 'number') {
              // Convert lovelace to ADA
              const priceAda = listingObject.price / 1_000_000;
              traitPrices.set(character, priceAda);
            }
          }
        }

        if (traitPrices.size > 0) {
          // Cache successful response
          this.relicsTraitPriceCache.set(cacheKey, traitPrices);

          return traitPrices;
        }
      }

      this.logger.warn('CNFT.tools API returned unexpected data structure for Relics Vita trait prices');
      return null;
    } catch (error: any) {
      this.logger.warn(`Failed to fetch Relics Vita trait prices from CNFT.tools: ${error.message}`);
      return null;
    }
  }

  /**
   * Fetch Relics of Magma Vita character trait from WayUp API
   * WayUp API returns properly decoded attributes including "attributes / Character"
   * @param policyId The policy ID of the NFT
   * @param name The readable asset name (e.g., "Relics of Magma - The Vita #0899")
   * @returns Character trait value or null if not found
   */
  private async fetchRelicsCharacterFromWayUp(policyId: string, name: string): Promise<string | null> {
    // Only works on mainnet - WayUp doesn't support testnet
    if (!this.isMainnet) {
      return null;
    }

    try {
      // Query WayUp API for the specific asset by name
      const response = await this.wayUpPricingService.getCollectionAssets({
        policyId,
        term: name,
        limit: 1,
      });

      if (response.results.length > 0) {
        const asset = response.results[0];
        // WayUp returns decoded attributes with key "attributes / Character"
        if (asset.attributes) {
          const character = this.extractCharacterTrait(asset.attributes);
          if (character) {
            return character;
          }
        }
      }

      this.logger.debug(`Character trait not found in WayUp response for ${name}`);
      return null;
    } catch (error: any) {
      this.logger.warn(`Failed to fetch character from WayUp: ${error.message}`);
      return null;
    }
  }

  /**
   * Ensure character trait is cached in asset metadata for Relics Vita NFTs
   * This is a fire-and-forget optimization that runs in the background
   * @param policyId The policy ID of the NFT
   * @param name The readable asset name
   * @param assetEntityId The asset entity ID
   */
  private async ensureRelicsCharacterCached(policyId: string, name: string, assetEntityId: string): Promise<void> {
    try {
      // Check if character is already cached
      const asset = await this.assetRepository.findOne({
        where: { id: assetEntityId },
        select: ['id', 'metadata'],
      });

      if (!asset) {
        return;
      }

      // If character is already cached, nothing to do
      if (asset.metadata?.character) {
        return;
      }

      // Fetch character from WayUp
      const character = await this.fetchRelicsCharacterFromWayUp(policyId, name);

      if (!character) {
        return;
      }

      // Cache the character in metadata
      const updatedMetadata = {
        ...(asset.metadata || {}),
        character,
      };

      await this.assetRepository.update({ id: assetEntityId }, { metadata: updatedMetadata });
    } catch (error: any) {
      // Silent failure - this is an optimization, not critical
      this.logger.debug(
        `Failed to background cache character trait: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get trait-based price for Relics of Magma NFTs
   * - Porta: Fetches floor price from WayUp API
   * - Vita: Fetches trait-based prices from CNFT.tools API with fallback to hardcoded prices
   * Falls back to hardcoded prices if APIs fail
   * @param policyId The policy ID of the NFT
   * @param name The readable asset name (e.g., "Relics of Magma - The Vita #0899")
   * @param assetEntityId Optional asset entity ID for caching character trait in metadata
   * @returns Price in ADA or null if not a Relics of Magma NFT
   */
  private async getRelicsOfMagmaPrice(policyId: string, name: string, assetEntityId?: string): Promise<number | null> {
    // Handle Relics of Magma - The Porta (fetch floor price from WayUp)
    if (policyId === this.RELICS_OF_MAGMA_PORTA_POLICY) {
      try {
        const floorPriceData = await this.wayUpPricingService.getCollectionFloorPrice(policyId);

        if (floorPriceData.hasListings && floorPriceData.floorPriceAda !== null) {
          return floorPriceData.floorPriceAda;
        }
      } catch (error: any) {
        this.logger.warn(`Failed to fetch Porta floor price from WayUp: ${error.message}`);
      }

      // Fallback to fixed price if WayUp fails or no listings
      return this.RELICS_PORTA_PRICE_FALLBACK;
    }

    // Handle Relics of Magma - The Vita (trait-based pricing from CNFT.tools)
    if (policyId === this.RELICS_OF_MAGMA_VITA_POLICY) {
      let character: string | null = null;

      // Priority 1: Check if character is cached in asset metadata
      if (assetEntityId) {
        try {
          const asset = await this.assetRepository.findOne({
            where: { id: assetEntityId },
            select: ['id', 'metadata'],
          });

          if (asset?.metadata?.character) {
            character = asset.metadata.character;
          }
        } catch (error: any) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.logger.debug(`Failed to fetch asset metadata for character caching: ${errorMessage}`);
        }
      } else {
        this.logger.debug('No assetEntityId provided, skipping metadata cache check');
      }

      // Priority 2: Fetch character trait from WayUp API if not cached
      if (!character) {
        character = await this.fetchRelicsCharacterFromWayUp(policyId, name);
        this.logger.debug(`WayUp returned character: ${character || 'null'}`);

        // Store the character in asset metadata for future use
        if (character && assetEntityId) {
          try {
            // Fetch the asset to get current metadata
            const asset = await this.assetRepository.findOne({
              where: { id: assetEntityId },
              select: ['id', 'metadata'],
            });

            if (asset) {
              // Merge character into existing metadata or create new metadata object
              const updatedMetadata = {
                ...(asset.metadata || {}),
                character,
              };

              const updateResult = await this.assetRepository.update(
                { id: assetEntityId },
                { metadata: updatedMetadata }
              );
              this.logger.debug(
                `Cached character trait in asset metadata: ${character}, affected: ${updateResult.affected}`
              );
            } else {
              this.logger.debug(`Asset ${assetEntityId} not found for metadata update`);
            }
          } catch (error: any) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.debug(`Failed to cache character trait in asset metadata: ${errorMessage}`);
          }
        } else if (!character) {
          this.logger.debug(`No character found from WayUp, cannot cache`);
        } else if (!assetEntityId) {
          this.logger.debug(`No assetEntityId provided, cannot cache character`);
        }
      }

      if (character) {
        // Priority 3: Try to get dynamic price from CNFT.tools API
        const traitPrices = await this.fetchRelicsVitaTraitPricesFromCNFT();

        if (traitPrices && traitPrices.has(character)) {
          const cnftPrice = traitPrices.get(character)!;
          return cnftPrice;
        }

        // Priority 4: Fallback to hardcoded prices if CNFT.tools API fails or character not found
        if (this.RELICS_CHARACTER_PRICES_FALLBACK[character]) {
          this.logger.debug(
            `Using fallback trait price for ${character}: ${this.RELICS_CHARACTER_PRICES_FALLBACK[character]} ADA`
          );
          return this.RELICS_CHARACTER_PRICES_FALLBACK[character];
        }
      }

      // If character trait not found or not recognized, log warning and use default
      this.logger.warn(`Character trait not found or not recognized for Vita NFT. Character: ${character}`);
      return this.RELICS_CHARACTER_PRICES_FALLBACK.Balaena; // Default to Balaena fallback price
    }

    return null;
  }

  /**
   * Get the value of an asset in ADA and USD
   * Uses DexHunter for fungible tokens and WayUp for NFT floor prices
   *
   * Price priority:
   * 1. Custom price from customPriceMap (vault-specific overrides)
   * 2. Hardcoded testnet prices
   * 3. External API prices (DexHunter for FTs, WayUp for NFTs)
   *    WITH DEVIATION PROTECTION: Fresh API prices are checked against cached database prices
   *
   * @returns Promise with the asset value in ADA and USD
   */
  async getAssetValue({
    policyId,
    assetName,
    isNFT,
    customPriceMap,
    name,
    assetEntityId,
  }: GetAssetValueParams): Promise<AssetPriceResult> {
    try {
      const adaPrice = await this.priceService.getAdaPrice();

      // Priority 1: Check for custom price override
      if (customPriceMap?.has(policyId)) {
        const customPrice = customPriceMap.get(policyId)!;
        return {
          priceAda: customPrice,
          priceUsd: customPrice * adaPrice,
        };
      }

      // Priority 2: Check for hardcoded testnet prices
      if (!this.isMainnet) {
        // Check for asset-specific price first (policyId + assetName)
        const assetId = `${policyId}${assetName}`;
        if (this.testnetPrices[assetId] !== undefined) {
          const hardcodedPriceAda = this.testnetPrices[assetId];
          return {
            priceAda: hardcodedPriceAda,
            priceUsd: hardcodedPriceAda * adaPrice,
          };
        }

        // Fall back to policy-level price
        if (this.testnetPrices[policyId] !== undefined) {
          const hardcodedPriceAda = this.testnetPrices[policyId];
          return {
            priceAda: hardcodedPriceAda,
            priceUsd: hardcodedPriceAda * adaPrice,
          };
        }
      }

      const cacheKey = `asset_value_${policyId}_${assetName}`;
      const cached = this.cache.get<{ priceAda: number; priceUsd: number }>(cacheKey);

      if (cached) return cached;

      // Skip external API calls for testnet - return fallback prices
      if (!this.isMainnet) {
        const fallbackPrice = 5.0; // Default testnet price
        return {
          priceAda: fallbackPrice,
          priceUsd: fallbackPrice * adaPrice,
        };
      }

      // Fetch cached price from database for deviation protection
      let cachedPriceAda: number | null = null;
      try {
        const assetInDb = await this.assetRepository.findOne({
          where: {
            policy_id: policyId,
            asset_id: assetName,
            deleted: false,
          },
          select: ['dex_price', 'floor_price', 'type'],
        });

        if (assetInDb) {
          cachedPriceAda =
            assetInDb.type === AssetType.NFT
              ? assetInDb.floor_price
                ? Number(assetInDb.floor_price)
                : null
              : assetInDb.dex_price
                ? Number(assetInDb.dex_price)
                : null;
        }
      } catch (error: any) {
        this.logger.debug(
          `Could not fetch cached price for ${policyId}.${assetName}: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      // Route to appropriate API based on asset type
      if (isNFT) {
        // Relics of Magma - The Porta: Use WayUp floor price
        if (policyId === this.RELICS_OF_MAGMA_PORTA_POLICY) {
          try {
            const traitPrice = await this.getRelicsOfMagmaPrice(policyId, name || '', assetEntityId);
            if (traitPrice !== null) {
              // Apply deviation protection
              const updateDecision = await this.shouldAcceptPriceUpdate({
                policyId,
                assetId: assetName,
                isNFT: true,
                previousPrice: cachedPriceAda,
                nextPrice: traitPrice,
                source: 'api',
              });

              if (!updateDecision.accepted) {
                // Price update rejected - use cached price if available
                if (cachedPriceAda !== null && cachedPriceAda > 0) {
                  this.logger.warn(
                    `Using cached price ${cachedPriceAda} ADA for Porta NFT ${policyId}.${assetName} instead of rejected fresh price ${traitPrice} ADA`
                  );
                  const result = {
                    priceAda: cachedPriceAda,
                    priceUsd: cachedPriceAda * adaPrice,
                  };
                  this.cache.set(cacheKey, result);
                  return result;
                } else {
                  // No cached price - use fallback
                  const result = {
                    priceAda: this.RELICS_PORTA_PRICE_FALLBACK,
                    priceUsd: this.RELICS_PORTA_PRICE_FALLBACK * adaPrice,
                  };
                  this.cache.set(cacheKey, result);
                  return result;
                }
              }

              const result = {
                priceAda: traitPrice,
                priceUsd: traitPrice * adaPrice,
              };
              this.cache.set(cacheKey, result);
              return result;
            }
          } catch (error: any) {
            this.logger.warn(`Failed to get floor price for Porta NFT, using fallback: ${error.message}`);
          }
          // Fallback if trait price fetch fails
          const result = {
            priceAda: this.RELICS_PORTA_PRICE_FALLBACK,
            priceUsd: this.RELICS_PORTA_PRICE_FALLBACK * adaPrice,
          };
          this.cache.set(cacheKey, result);
          return result;
        }

        // Relics of Magma - The Vita: TapTools trait-based pricing
        if (policyId === this.RELICS_OF_MAGMA_VITA_POLICY) {
          try {
            // Fetch trait-based price from TapTools API using WayUp for character extraction
            // Pass the readable name for WayUp character trait search
            const traitPrice = await this.getRelicsOfMagmaPrice(policyId, name || '', assetEntityId);
            if (traitPrice !== null) {
              // Apply deviation protection
              const updateDecision = await this.shouldAcceptPriceUpdate({
                policyId,
                assetId: assetName,
                isNFT: true,
                previousPrice: cachedPriceAda,
                nextPrice: traitPrice,
                source: 'api',
              });

              if (!updateDecision.accepted) {
                // Price update rejected - use cached price if available
                if (cachedPriceAda !== null && cachedPriceAda > 0) {
                  this.logger.warn(
                    `Using cached price ${cachedPriceAda} ADA for Vita NFT ${policyId}.${assetName} instead of rejected fresh price ${traitPrice} ADA`
                  );
                  const result = {
                    priceAda: cachedPriceAda,
                    priceUsd: cachedPriceAda * adaPrice,
                  };
                  this.cache.set(cacheKey, result);
                  return result;
                } else {
                  // No cached price - use fallback
                  const fallbackPrice = this.RELICS_CHARACTER_PRICES_FALLBACK.Balaena;
                  const result = {
                    priceAda: fallbackPrice,
                    priceUsd: fallbackPrice * adaPrice,
                  };
                  this.cache.set(cacheKey, result);
                  return result;
                }
              }

              const result = {
                priceAda: traitPrice,
                priceUsd: traitPrice * adaPrice,
              };
              this.cache.set(cacheKey, result);
              return result;
            }
          } catch (error: any) {
            // Fallback to Balaena price for Vita on error
            this.logger.warn(`Failed to get trait-based price for Vita NFT, using Balaena fallback: ${error.message}`);
            const fallbackPrice = this.RELICS_CHARACTER_PRICES_FALLBACK.Balaena;
            const result = {
              priceAda: fallbackPrice,
              priceUsd: fallbackPrice * adaPrice,
            };
            this.cache.set(cacheKey, result);
            return result;
          }
        }

        // Default NFT pricing using WayUp floor price
        try {
          const { floorPriceAda } = await this.wayUpPricingService.getCollectionFloorPrice(policyId);
          if (floorPriceAda > 0) {
            // Apply deviation protection for NFT prices
            const updateDecision = await this.shouldAcceptPriceUpdate({
              policyId,
              assetId: assetName,
              isNFT: true,
              previousPrice: cachedPriceAda,
              nextPrice: floorPriceAda,
              source: 'api',
            });

            if (!updateDecision.accepted) {
              // Price update rejected - use cached price if available
              if (cachedPriceAda !== null && cachedPriceAda > 0) {
                this.logger.warn(
                  `Using cached price ${cachedPriceAda} ADA for NFT ${policyId}.${assetName} instead of rejected fresh price ${floorPriceAda} ADA`
                );
                const result = {
                  priceAda: cachedPriceAda,
                  priceUsd: cachedPriceAda * adaPrice,
                };
                this.cache.set(cacheKey, result);
                return result;
              } else {
                // No cached price - return 0 to prevent using manipulated price
                this.logger.warn(
                  `No cached price available for NFT ${policyId}.${assetName}, rejecting fresh price and returning 0`
                );
                return { priceAda: 0, priceUsd: 0 };
              }
            }

            this.cache.set(cacheKey, { priceAda: floorPriceAda, priceUsd: floorPriceAda * adaPrice });
            return { priceAda: floorPriceAda, priceUsd: floorPriceAda * adaPrice };
          }
        } catch (error: any) {
          this.logger.warn(`WayUp floor price failed for NFT ${policyId}: ${error.message}`);
        }
      } else {
        // Get token price from DexHunter service (prioritizes VyFi cache, falls back to DexHunter/TapTools)
        const tokenUnit = `${policyId}${assetName}`;

        const tokenPriceAda = await this.dexHunterPricingService.getTokenPrice(tokenUnit);

        if (tokenPriceAda !== null && tokenPriceAda > 0) {
          // Apply deviation protection for FT prices
          const updateDecision = await this.shouldAcceptPriceUpdate({
            policyId,
            assetId: assetName,
            isNFT: false,
            previousPrice: cachedPriceAda,
            nextPrice: tokenPriceAda,
            source: 'api',
          });

          if (!updateDecision.accepted) {
            // Price update rejected - use cached price if available
            if (cachedPriceAda !== null && cachedPriceAda > 0) {
              this.logger.warn(
                `Using cached price ${cachedPriceAda} ADA for FT ${policyId}.${assetName} instead of rejected fresh price ${tokenPriceAda} ADA`
              );
              const result = {
                priceAda: cachedPriceAda,
                priceUsd: cachedPriceAda * adaPrice,
              };
              this.cache.set(cacheKey, result);
              return result;
            } else {
              // No cached price - return 0 to prevent using manipulated price
              this.logger.warn(
                `No cached price available for FT ${policyId}.${assetName}, rejecting fresh price and returning 0`
              );
              return { priceAda: 0, priceUsd: 0 };
            }
          }

          const result = {
            priceAda: tokenPriceAda,
            priceUsd: tokenPriceAda * adaPrice,
          };
          this.cache.set(cacheKey, result);
          return result;
        }

        this.logger.warn(`DexHunter price not available for FT ${policyId}`);
      }

      // Return cached price if available, otherwise 0
      if (cachedPriceAda !== null && cachedPriceAda > 0) {
        this.logger.debug(
          `No fresh price available for ${policyId}.${assetName}, using cached price ${cachedPriceAda} ADA`
        );
        return {
          priceAda: cachedPriceAda,
          priceUsd: cachedPriceAda * adaPrice,
        };
      }

      return { priceAda: 0, priceUsd: 0 };
    } catch (error: any) {
      this.logger.error(`Failed to get asset value for ${policyId}:`, error.message);
      // Return fallback price on error
      return { priceAda: 0, priceUsd: 0 };
    }
  }

  /**
   * Helper function to process promises with controlled concurrency
   * @param items Array of items to process
   * @param fn Async function to execute for each item
   * @param concurrency Maximum number of concurrent operations
   * @param delayMs Delay in milliseconds between batches
   */
  private async processWithConcurrency<T, R>(
    items: T[],
    fn: (item: T) => Promise<R>,
    concurrency: number = 5,
    delayMs: number = 100
  ): Promise<R[]> {
    const results: R[] = [];

    for (let i = 0; i < items.length; i += concurrency) {
      const batch = items.slice(i, i + concurrency);
      const batchResults = await Promise.all(batch.map(item => fn(item)));
      results.push(...batchResults);

      // Add delay between batches to avoid rate limiting (except for last batch)
      if (i + concurrency < items.length) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    return results;
  }

  /**
   * Update asset prices in database from custom vault prices and external APIs (DexHunter/WayUp)
   * Updates dex_price for FTs and floor_price for NFTs
   * Includes assets with PENDING, LOCKED, and EXTRACTED (in treasury wallet) status
   * Uses controlled concurrency to avoid overwhelming external APIs
   * After updating prices, calculates and returns TVL for affected vaults
   *
   * Price priority:
   * 1. Custom prices from vault whitelist (valuation_method = 'custom')
   * 2. Hardcoded testnet prices
   * 3. External API prices (DexHunter for FTs, WayUp for NFTs)
   *
   * @param vaultIds Array of vault IDs to update assets for.
   * @returns Map of vaultId -> asset summary with updated prices
   */
  async updateAssetPrices(
    vaultIds: string[]
  ): Promise<
    Map<string, { totalValueAda: number; totalValueUsd: number; totalValueEth: number; totalAcquiredAda: number }>
  > {
    try {
      // Build query to get unique assets across specified vaults
      const assets: Array<
        Pick<Asset, 'id' | 'policy_id' | 'asset_id' | 'type' | 'name' | 'vault_id' | 'dex_price' | 'floor_price'>
      > = await this.assetRepository.find({
        where: {
          status: In([AssetStatus.PENDING, AssetStatus.LOCKED, AssetStatus.EXTRACTED]),
          deleted: false,
          vault: { id: In(vaultIds) },
        },
        select: ['id', 'policy_id', 'asset_id', 'type', 'name', 'vault_id', 'dex_price', 'floor_price'],
      });

      // Deduplicate by policy_id + asset_id + vault_id
      const uniqueAssetsMap = new Map<string, (typeof assets)[0]>();
      for (const asset of assets) {
        const key = `${asset.policy_id}_${asset.asset_id}_${asset.vault_id}`;
        if (!uniqueAssetsMap.has(key)) {
          uniqueAssetsMap.set(key, asset);
        }
      }
      const uniqueAssets = Array.from(uniqueAssetsMap.values());

      // Load custom prices for all relevant vaults
      const customPricesByVault = new Map<string, Map<string, number>>();

      for (const vaultId of vaultIds) {
        const { customPrices } = await this.getVaultCustomPrices(vaultId);
        if (customPrices.size > 0) {
          customPricesByVault.set(vaultId, customPrices);
        }
      }

      let updatedCount = 0;
      const rejectedUpdates: Array<{
        policyId: string;
        assetId: string;
        assetClass: 'NFT' | 'FT';
        source: string;
        direction: 'up' | 'down';
        previousPrice: number;
        nextPrice: number;
        absoluteMoveAda: number;
        minAbsoluteMoveAda: number;
        deviationPercent: number;
        thresholdPercent: number;
      }> = [];

      // Process with controlled concurrency: 5 concurrent API calls, 100ms delay between batches
      await this.processWithConcurrency(
        uniqueAssets,
        async asset => {
          try {
            // Skip lovelace
            if (asset.type === AssetType.ADA) {
              return;
            }

            const isNFT = asset.type === AssetType.NFT;

            let priceAda: number | null = null;
            let priceSource: 'custom' | 'testnet' | 'api' = 'api';

            // Priority 1: Check for custom price from vault whitelist
            const vaultCustomPrices = customPricesByVault.get(asset.vault_id);
            if (vaultCustomPrices && vaultCustomPrices.has(asset.policy_id)) {
              priceAda = vaultCustomPrices.get(asset.policy_id)!;
              priceSource = 'custom';
            }
            // Priority 2: Use hardcoded testnet prices if available
            else if (!this.isMainnet) {
              priceAda = this.testnetPrices[asset.policy_id] || 5.0;
              priceSource = 'testnet';
            }
            // Priority 3: Fetch from external APIs
            else if (isNFT) {
              // Check for Relics of Magma trait-based pricing first
              const relicsPrice = await this.getRelicsOfMagmaPrice(asset.policy_id, asset.name, asset.id);
              if (relicsPrice !== null) {
                priceAda = relicsPrice;
              } else {
                // Fall back to WayUp collection floor price for other NFTs
                try {
                  const { floorPriceAda } = await this.wayUpPricingService.getCollectionFloorPrice(asset.policy_id);
                  priceAda = floorPriceAda > 0 ? floorPriceAda : null;
                } catch (error: any) {
                  this.logger.debug(`Failed to get floor price for NFT ${asset.policy_id}: ${error.message}`);
                }
              }
            } else {
              // Get DEX price from DexHunter service (prioritizes VyFi cache, falls back to DexHunter/TapTools)
              try {
                const tokenUnit = `${asset.policy_id}${asset.asset_id}`;
                const tokenPriceAda = await this.dexHunterPricingService.getTokenPrice(tokenUnit);

                priceAda = tokenPriceAda !== null && tokenPriceAda > 0 ? tokenPriceAda : null;
              } catch (error: any) {
                this.logger.debug(`Failed to get DEX price for FT ${asset.policy_id}: ${error.message}`);
              }
            }

            if (priceAda !== null) {
              const previousPrice = isNFT ? asset.floor_price : asset.dex_price;
              const updateDecision = await this.shouldAcceptPriceUpdate({
                policyId: asset.policy_id,
                assetId: asset.asset_id,
                isNFT,
                previousPrice,
                nextPrice: priceAda,
                source: priceSource,
              });

              if (!updateDecision.accepted) {
                rejectedUpdates.push(updateDecision.rejectionReason!);
                return;
              }

              // Update all assets with this policy_id and asset_id
              await this.assetRepository.update(
                {
                  policy_id: asset.policy_id,
                  asset_id: asset.asset_id,
                  deleted: false,
                },
                {
                  [isNFT ? 'floor_price' : 'dex_price']: priceAda,
                  last_valuation: new Date(),
                }
              );
              updatedCount++;
            }
          } catch (error: any) {
            this.logger.error(`Error updating price for asset ${asset.policy_id}.${asset.asset_id}:`, error.message);
          }
        },
        5, // Max 5 concurrent API calls
        100 // 100ms delay between batches
      );

      if (updatedCount > 0) {
        this.logger.log(`Updated prices for ${updatedCount} assets across ${vaultIds.length} vaults`);
      }

      // Send aggregated alert for all rejected updates in this batch
      if (rejectedUpdates.length > 0) {
        this.logger.warn(
          `${rejectedUpdates.length} asset price updates exceeded deviation threshold and were skipped for manual review`
        );
        // await this.alertsService.sendAlert('asset_price_deviation_batch_exceeded', {
        //   totalRejected: rejectedUpdates.length,
        //   rejectedAssets: rejectedUpdates,
        //   action: 'price_updates_rejected_manual_review_required',
        // });
      }

      // Calculate and return TVL for all affected vaults
      return await this.calculateVaultsTvl(vaultIds);
    } catch (error: any) {
      this.logger.error('Error in updateAssetPrices:', error.message);
      throw error;
    }
  }

  /**
   * Calculate the total value of all assets in a vault
   * Includes assets with PENDING, LOCKED, and EXTRACTED (in treasury wallet) status
   * Uses cached prices from database (dex_price/floor_price)
   * Set updatePrices=true only during phase transitions to fetch fresh prices
   * @param vaultId The ID of the vault
   * @param updatePrices If true, fetches fresh prices from APIs. If false, uses cached prices
   * @returns Promise with the vault assets summary
   */
  async getVaultAssetsSummary(vaultId: string, updatePrices: boolean = false): Promise<VaultAssetsSummaryDto> {
    // Get the vault to verify it exists
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      relations: ['assets', 'owner'],
    });

    if (!vault) {
      throw new NotFoundException(`Vault with ID ${vaultId} not found`);
    }

    // If updatePrices is true, fetch fresh prices first
    if (updatePrices) {
      await this.updateAssetPrices([vaultId]);
    }

    // Load custom prices from vault whitelist
    const { customPrices: customPriceMap } = await this.getVaultCustomPrices(vaultId);
    const [adaPrice, ethPrice] = await Promise.all([this.priceService.getAdaPrice(), this.priceService.getEthPrice()]);

    // Group assets by policyId and assetId to handle quantities
    const assetMap = new Map<
      string,
      {
        id?: string;
        policyId: string;
        assetId: string;
        quantity: number;
        acquiredQuantity: number;
        isNft: boolean;
        cachedPrice?: number;
        metadata?: Record<string, unknown>;
        name?: string;
      }
    >();

    let totalAcquiredAda = 0;

    // Group assets and track acquired quantities in one pass
    for (const asset of vault.assets) {
      // Skip assets that are not in a valid status for valuation
      // Include PENDING, LOCKED, and EXTRACTED (in treasury wallet)
      if (
        asset.status !== AssetStatus.PENDING &&
        asset.status !== AssetStatus.LOCKED &&
        asset.status !== AssetStatus.EXTRACTED
      ) {
        continue;
      }

      const key = `${asset.policy_id}_${asset.asset_id}`;
      const existingAsset = assetMap.get(key);

      if (existingAsset) {
        existingAsset.quantity += asset.normalizedQuantity;
        if (asset.origin_type === AssetOriginType.ACQUIRED) {
          existingAsset.acquiredQuantity += asset.normalizedQuantity;
        }
      } else {
        // Check for custom price first, then use cached market price
        let cachedPrice: number | undefined;
        if (customPriceMap && customPriceMap.has(asset.policy_id)) {
          cachedPrice = customPriceMap.get(asset.policy_id);
        } else {
          // Use cached market price from database (dex_price for FTs, floor_price for NFTs)
          cachedPrice = asset.type === AssetType.NFT ? asset.floor_price : asset.dex_price;
          cachedPrice = cachedPrice ? Number(cachedPrice) : undefined;
        }

        assetMap.set(key, {
          id: asset.id,
          policyId: asset.policy_id,
          assetId: asset.asset_id,
          quantity: asset.normalizedQuantity,
          acquiredQuantity: asset.origin_type === AssetOriginType.ACQUIRED ? asset.normalizedQuantity : 0,
          isNft: asset.type === AssetType.NFT,
          cachedPrice,
          metadata: asset.metadata || {},
          name: asset.name,
        });
      }
    }

    // Calculate values for grouped assets
    const assetsWithValues = [];
    let totalValueAda = 0;
    let totalValueUsd = 0;

    for (const asset of assetMap.values()) {
      try {
        // Skip administrative/fee tokens
        if (asset.metadata?.purpose === 'vault_creation_fee') {
          assetsWithValues.push({
            ...asset,
            assetName: asset.assetId,
            valueAda: 0,
            valueUsd: 0,
          });
          continue;
        }

        if (asset.assetId === 'lovelace') {
          const totalAdaValue = asset.quantity * 1e-6;
          const acquiredAdaValue = asset.acquiredQuantity * 1e-6;
          assetsWithValues.push({
            ...asset,
            assetName: 'ADA',
            valueAda: totalAdaValue,
            valueUsd: totalAdaValue * adaPrice,
          });
          totalValueAda += totalAdaValue;
          totalValueUsd += totalAdaValue * adaPrice;
          totalAcquiredAda += acquiredAdaValue;
          continue;
        }

        // Use cached price if available and not updating prices
        let valueAda = 0;
        let valueUsd = 0;

        if (asset.cachedPrice !== undefined && asset.cachedPrice > 0) {
          // Use cached price from database
          valueAda = asset.cachedPrice;
          valueUsd = valueAda * adaPrice;

          // Special handling: For Relics Vita NFTs, ensure character trait is cached even when using cached price
          if (asset.policyId === this.RELICS_OF_MAGMA_VITA_POLICY && asset.id && asset.name) {
            // Fire and forget - cache the character trait in the background without blocking
            void this.ensureRelicsCharacterCached(asset.policyId, asset.name, asset.id);
          }
        } else {
          const assetValue = await this.getAssetValue({
            policyId: asset.policyId,
            assetName: asset.assetId,
            isNFT: asset.isNft,
            customPriceMap,
            name: asset.name,
            assetEntityId: asset.id,
          });
          valueAda = assetValue?.priceAda || 0;
          valueUsd = assetValue?.priceUsd || 0;
        }

        const totalAssetValueAda = valueAda * asset.quantity;
        const totalAssetValueUsd = valueUsd * asset.quantity;

        assetsWithValues.push({
          ...asset,
          assetName: asset.assetId,
          valueAda: totalAssetValueAda,
          valueUsd: totalAssetValueUsd,
        });

        totalValueAda += totalAssetValueAda;
        totalValueUsd += totalAssetValueUsd;
        totalAcquiredAda += valueAda * asset.acquiredQuantity;
      } catch (error: any) {
        console.warn(`Could not value asset ${asset.policyId}.${asset.assetId}:`, error.message);
      }
    }

    if (updatePrices && assetsWithValues.length > 0) {
      await this.assetsService.updateBulkAssetValuations(
        assetsWithValues.map(asset => ({
          policyId: asset.policyId,
          assetId: asset.assetId,
          valueAda: asset.valueAda / asset.quantity, // Get per-unit price
          isNft: asset.isNft,
        }))
      );
      await this.userRepository.update({ id: vault.owner.id }, { tvl: totalValueAda });
    }

    // Add treasury wallet balance to protocol TVL (if exists)
    let treasuryAdaValue = 0;

    try {
      if (this.treasuryWalletService) {
        const treasuryBalance = await this.treasuryWalletService.getTreasuryWalletBalance(vault.id);

        if (treasuryBalance) {
          // Add ADA from treasury
          treasuryAdaValue = treasuryBalance.lovelace * 1e-6;
          totalValueAda += treasuryAdaValue;
          totalValueUsd += treasuryAdaValue * adaPrice;

          // Value treasury assets (NFTs and FTs)
          for (const asset of treasuryBalance.assets) {
            try {
              // Determine if asset is NFT by quantity (1 = NFT, >1 = FT)
              const isNft = asset.quantity === '1';
              const quantity = Number(asset.quantity);

              const assetValue = await this.getAssetValue({
                policyId: asset.policyId,
                assetName: asset.assetName,
                isNFT: isNft,
                customPriceMap,
                // Note: Treasury assets don't have DB entity IDs, so character trait caching won't work
              });
              const valueAda = assetValue?.priceAda || 0;

              totalValueAda += valueAda * quantity;
              totalValueUsd += valueAda * adaPrice * quantity;
            } catch (error: any) {
              this.logger.debug(`Could not value treasury asset ${asset.unit}: ${error.message}`);
            }
          }
        }
      }
    } catch (error: any) {
      // Treasury wallet doesn't exist or error fetching - continue without it
      this.logger.debug(`No treasury wallet for vault ${vault.id}: ${error.message}`);
    }

    // Group assets by policy ID for progress bars
    const assetsByPolicyMap = new Map<string, { policyId: string; quantity: number }>();

    for (const asset of assetsWithValues) {
      // Skip lovelace and fee tokens from policy grouping
      if (asset.assetId === 'lovelace' || asset.assetId === 'ADA' || asset.metadata?.purpose === 'vault_creation_fee') {
        continue;
      }

      const existing = assetsByPolicyMap.get(asset.policyId);
      if (existing) {
        existing.quantity += asset.quantity;
      } else {
        assetsByPolicyMap.set(asset.policyId, {
          policyId: asset.policyId,
          quantity: asset.quantity,
        });
      }
    }

    // Create and return the summary
    return {
      totalValueAda: +totalValueAda.toFixed(6),
      totalValueUsd: +totalValueUsd.toFixed(2),
      totalValueEth: +(totalValueUsd / ethPrice).toFixed(6),
      totalAssets: assetsWithValues.length,
      nfts: assetsWithValues.filter(a => a.isNft).length,
      tokens: assetsWithValues.filter(a => !a.isNft).length,
      lastUpdated: new Date().toISOString(),
      totalAcquiredAda,
      totalAcquiredUsd: totalAcquiredAda * adaPrice,
      adaPrice,
      assetsByPolicy: Array.from(assetsByPolicyMap.values()),
    };
  }

  /**
   * Batch calculate vault TVL for multiple vaults
   * Includes assets with PENDING, LOCKED, and EXTRACTED (in treasury wallet) status
   * Uses cached prices from database (dex_price/floor_price) or custom prices from whitelist
   * @param vaultIds Array of vault IDs to calculate values for
   * @returns Map of vaultId -> asset summary
   */
  async calculateVaultsTvl(
    vaultIds: string[]
  ): Promise<
    Map<string, { totalValueAda: number; totalValueUsd: number; totalValueEth: number; totalAcquiredAda: number }>
  > {
    const resultMap = new Map<
      string,
      { totalValueAda: number; totalValueUsd: number; totalValueEth: number; totalAcquiredAda: number }
    >();

    if (vaultIds.length === 0) {
      return resultMap;
    }

    try {
      // Fetch all vaults at once
      const vaults = await this.vaultRepository.find({
        where: { id: In(vaultIds) },
        relations: ['assets'],
      });

      // Load custom prices for all vaults
      const customPricesMap = new Map<string, Map<string, number>>();
      await Promise.all(
        vaults.map(async vault => {
          const { customPrices } = await this.getVaultCustomPrices(vault.id);
          if (customPrices && customPrices.size > 0) {
            customPricesMap.set(vault.id, customPrices);
          }
        })
      );

      const [adaPrice, ethPrice] = await Promise.all([
        this.priceService.getAdaPrice(),
        this.priceService.getEthPrice(),
      ]);

      // Process each vault
      for (const vault of vaults) {
        let totalValueAda = 0;
        let totalValueUsd = 0;
        let totalValueEth = 0;
        let totalAcquiredAda = 0;

        const vaultCustomPrices = customPricesMap.get(vault.id);

        // Group assets by policyId and assetId with cached prices
        const assetMap = new Map<
          string,
          {
            id?: string;
            policyId: string;
            assetId: string;
            quantity: number;
            isNft: boolean;
            cachedPrice?: number;
            name?: string;
          }
        >();

        for (const asset of vault.assets) {
          // Skip invalid statuses
          // Include PENDING, LOCKED, and EXTRACTED (in treasury wallet)
          if (
            asset.status !== AssetStatus.PENDING &&
            asset.status !== AssetStatus.LOCKED &&
            asset.status !== AssetStatus.EXTRACTED
          ) {
            continue;
          }

          // Track acquired value in ADA-equivalent (reserve checks use ADA value)
          if (asset.origin_type === AssetOriginType.ACQUIRED) {
            if (asset.type === AssetType.ADA) {
              totalAcquiredAda += asset.normalizedQuantity;
            } else if (asset.type === AssetType.ETH) {
              const ethPriceInAda = adaPrice > 0 ? ethPrice / adaPrice : 0;
              totalAcquiredAda += asset.normalizedQuantity * ethPriceInAda;
            }
          }

          // Process vault-owned assets for TVL:
          // CONTRIBUTED (user deposits) + BOUGHT (marketplace buys) + FEE (protocol fees).
          if (
            asset.origin_type !== AssetOriginType.CONTRIBUTED &&
            asset.origin_type !== AssetOriginType.BOUGHT &&
            asset.origin_type !== AssetOriginType.FEE
          ) {
            continue;
          }

          const key = `${asset.policy_id}_${asset.asset_id}`;
          const existingAsset = assetMap.get(key);

          if (existingAsset) {
            existingAsset.quantity += asset.normalizedQuantity;
          } else {
            // Check for custom price first, then use cached market price
            let cachedPrice: number | undefined;
            if (vaultCustomPrices && vaultCustomPrices.has(asset.policy_id)) {
              cachedPrice = vaultCustomPrices.get(asset.policy_id);
            } else {
              // Use cached market price from database
              const marketPrice = asset.type === AssetType.NFT ? asset.floor_price : asset.dex_price;
              cachedPrice = marketPrice ? Number(marketPrice) : undefined;
            }

            assetMap.set(key, {
              id: asset.id,
              policyId: asset.policy_id,
              assetId: asset.asset_id,
              quantity: asset.normalizedQuantity,
              isNft: asset.type === AssetType.NFT,
              cachedPrice,
              name: asset.name,
            });
          }
        }

        // Calculate values for all assets using cached prices
        const assets = Array.from(assetMap.values());

        for (const asset of assets) {
          try {
            // Handle ADA specially
            if (asset.assetId === 'lovelace') {
              const totalAdaValue = asset.quantity * 1e-6;
              totalValueAda += totalAdaValue;
              totalValueUsd += totalAdaValue * adaPrice;
              continue;
            }

            // Use cached price if available
            let valueAda = 0;

            if (asset.cachedPrice !== undefined && asset.cachedPrice > 0) {
              valueAda = asset.cachedPrice;

              // Special handling: For Relics Vita NFTs, ensure character trait is cached even when using cached price
              // This allows us to optimize trait-based pricing by avoiding repeated WayUp API calls
              if (asset.policyId === this.RELICS_OF_MAGMA_VITA_POLICY && asset.id && asset.name) {
                // Fire and forget - cache the character trait in the background without blocking TVL calculation
                void this.ensureRelicsCharacterCached(asset.policyId, asset.name, asset.id);
              }
            } else {
              const assetValue = await this.getAssetValue({
                policyId: asset.policyId,
                assetName: asset.assetId,
                isNFT: asset.isNft,
                customPriceMap: vaultCustomPrices,
                name: asset.name,
                assetEntityId: asset.id,
              });
              valueAda = assetValue?.priceAda || 0;
            }

            totalValueAda += valueAda * asset.quantity;
            totalValueUsd += valueAda * adaPrice * asset.quantity;
          } catch (error: any) {
            // Skip assets that can't be valued
            this.logger.debug(`Could not value asset ${asset.policyId}.${asset.assetId}: ${error.message}`);
          }
        }

        // Add treasury wallet balance to protocol TVL (if exists)
        let treasuryAdaValue = 0;

        try {
          if (this.treasuryWalletService) {
            const treasuryBalance = await this.treasuryWalletService.getTreasuryWalletBalance(vault.id);

            if (treasuryBalance) {
              // Add ADA from treasury
              treasuryAdaValue = treasuryBalance.lovelace * 1e-6;
              totalValueAda += treasuryAdaValue;
              totalValueUsd += treasuryAdaValue * adaPrice;

              // Value treasury assets (NFTs and FTs)
              for (const asset of treasuryBalance.assets) {
                try {
                  // Determine if asset is NFT by quantity (1 = NFT, >1 = FT)
                  const isNft = asset.quantity === '1';
                  const quantity = Number(asset.quantity);

                  const assetValue = await this.getAssetValue({
                    policyId: asset.policyId,
                    assetName: asset.assetName,
                    isNFT: isNft,
                    customPriceMap: vaultCustomPrices,
                  });
                  const valueAda = assetValue?.priceAda || 0;

                  totalValueAda += valueAda * quantity;
                  totalValueUsd += valueAda * adaPrice * quantity;
                } catch (error: any) {
                  this.logger.debug(`Could not value treasury asset ${asset.unit}: ${error.message}`);
                }
              }
            }
          }
        } catch (error: any) {
          // Treasury wallet doesn't exist or error fetching - continue without it
          this.logger.debug(`No treasury wallet for vault ${vault.id}: ${error.message}`);
        }
        totalValueEth = totalValueUsd / ethPrice;

        resultMap.set(vault.id, {
          totalValueAda: +totalValueAda.toFixed(6),
          totalValueUsd: +totalValueUsd.toFixed(2),
          totalValueEth: +totalValueEth.toFixed(6),
          totalAcquiredAda,
        });
      }

      return resultMap;
    } catch (error: any) {
      this.logger.error('Error in batch calculate vault assets:', error.message);
      // Return empty map on error
      return resultMap;
    }
  }

  /**
   * Update cached vault totals for multiple vaults
   * Includes assets with PENDING, LOCKED, EXTRACTED (in treasury), and DISTRIBUTED status
   *
   * User TVL and Gains Calculation:
   * - Locked/Expansion/Acquire_Expansion vaults WITH LP: VT token price appreciation from historical OHLCV data
   *   Uses VaultMarketStatsService.calculateTokenPriceDelta() to get true price from LP inception
   * - Locked/Expansion/Acquire_Expansion vaults WITHOUT LP: VT token holdings × proportional TVL ownership
   * - Active vaults (contribution/acquire): NO user gains calculated (users don't have VT tokens yet)
   *
   * For locked, expansion, and acquire_expansion vaults, also calculates FDV/TVL ratio
   *
   * GAINS CALCULATION OVERVIEW:
   * - LP vaults: Uses full OHLCV history (first day open → latest close) from TapTools to
   *   derive the percentage change in VT token price from inception, and then applies this
   *   percentage change to the user's VT token holdings (scaled by the current VT price) to
   *   compute user_gains_ada.
   * - Non-LP locked/expansion/acquire_expansion vaults: DO NOT use historical TVL snapshots for gains calculation. Instead, calculate the user's
   * proportional ownership of the vault based on their VT token holdings relative to total supply, and then apply this ownership percentage to the current TVL to derive user_gains_ada. This approach avoids inaccuracies that can arise from using historical snapshots in volatile markets.
   * - Contribution/Acquire: No calculation (users don't own VT tokens yet)
   *
   * @param vaultIds Array of vault IDs to update
   */
  async updateMultipleVaultTotals(vaultIds: string[]): Promise<void> {
    if (vaultIds.length === 0) return;

    const batchResults = await this.calculateVaultsTvl(vaultIds);

    const vaults: Pick<
      Vault,
      'id' | 'initial_total_value_ada' | 'vault_status' | 'ft_token_supply' | 'fdv' | 'owner'
    >[] = await this.vaultRepository.find({
      where: { id: In(vaultIds) },
      relations: ['owner'],
      select: ['id', 'initial_total_value_ada', 'vault_status', 'ft_token_supply', 'fdv', 'owner'],
    });

    const vaultMap = new Map(vaults.map(v => [v.id, v]));

    // Update vault totals
    const updatePromises = Array.from(batchResults.entries()).map(([vaultId, summary]) => {
      const vault = vaultMap.get(vaultId);

      const updateData: Partial<Vault> = {
        total_assets_cost_ada: summary.totalValueAda,
        total_assets_cost_usd: summary.totalValueUsd,
        total_assets_cost_eth: summary.totalValueEth,
        total_acquired_value_ada: summary.totalAcquiredAda,
        last_valuation_update: new Date(),
      };

      // Update FDV/TVL ratio for locked vaults
      if (vault?.vault_status === VaultStatus.locked && vault.fdv && summary.totalValueAda > 0.0001) {
        updateData.fdv_tvl = Number((vault.fdv / summary.totalValueAda).toFixed(2));
      }

      return this.vaultRepository.update({ id: vaultId }, updateData);
    });

    await Promise.all(updatePromises);

    // Batch fetch all data needed to identify affected users
    const activeVaultIds = Array.from(batchResults.keys()).filter(vaultId => {
      const vault = vaultMap.get(vaultId);
      return vault && (vault.vault_status === VaultStatus.contribution || vault.vault_status === VaultStatus.acquire);
    });

    const lockedVaultIds = Array.from(batchResults.keys()).filter(vaultId => {
      const vault = vaultMap.get(vaultId);
      return vault && vault.vault_status === VaultStatus.locked;
    });

    // Batch query: Get all contributors for active vaults
    const contributorsRaw =
      activeVaultIds.length > 0
        ? await this.assetRepository
            .createQueryBuilder('asset')
            .select(['asset.vault_id as vault_id', 'asset.added_by as added_by'])
            .where('asset.vault_id IN (:...vaultIds)', { vaultIds: activeVaultIds })
            .andWhere('asset.status IN (:...statuses)', {
              statuses: [AssetStatus.LOCKED, AssetStatus.DISTRIBUTED, AssetStatus.EXTRACTED],
            })
            .andWhere('asset.origin_type = :originType', { originType: AssetOriginType.CONTRIBUTED })
            .andWhere('asset.added_by IS NOT NULL')
            .distinct(true)
            .getRawMany()
        : [];

    // Batch query: Get all snapshots for locked vaults (latest per vault)
    const snapshots =
      lockedVaultIds.length > 0
        ? await this.snapshotRepository
            .createQueryBuilder('snapshot')
            .distinctOn(['snapshot.vault_id'])
            .where('snapshot.vault_id IN (:...vaultIds)', { vaultIds: lockedVaultIds })
            .orderBy('snapshot.vault_id', 'ASC')
            .addOrderBy('snapshot.created_at', 'DESC')
            .getMany()
        : [];

    // Collect all unique addresses from snapshots
    const snapshotAddresses = new Set<string>();
    snapshots.forEach(snapshot => {
      if (snapshot.addressBalances) {
        Object.keys(snapshot.addressBalances).forEach(addr => snapshotAddresses.add(addr));
      }
    });

    // Batch query: Get all users by addresses
    const usersByAddress =
      snapshotAddresses.size > 0
        ? await this.userRepository.find({
            where: { address: In([...snapshotAddresses]) },
            select: ['id', 'address'],
          })
        : [];

    const addressToUserIdMap = new Map(usersByAddress.map(u => [u.address, u.id]));

    // Identify affected users
    const affectedUserIds = new Set<string>();

    // Add vault owners
    vaultMap.forEach(vault => {
      if (vault.owner?.id) affectedUserIds.add(vault.owner.id);
    });

    // Add contributors
    contributorsRaw.forEach(c => {
      if (c.added_by) affectedUserIds.add(c.added_by);
    });

    // Add VT token holders
    snapshots.forEach(snapshot => {
      if (snapshot.addressBalances) {
        Object.keys(snapshot.addressBalances).forEach(address => {
          const userId = addressToUserIdMap.get(address);
          if (userId) affectedUserIds.add(userId);
        });
      }
    });

    // Recalculate complete TVL and gains for all affected users from ALL their vaults
    if (affectedUserIds.size > 0) {
      // this.logger.debug(`Recalculating TVL and gains for ${affectedUserIds.size} users`);

      // Batch query: Get all relevant vaults
      const allRelevantVaults = await this.vaultRepository.find({
        where: {
          deleted: false,
          vault_status: In(VAULT_STATUSES_ACTIVE),
        },
        relations: ['owner'],
        select: ['id', 'vault_status', 'ft_token_supply', 'ft_token_decimals', 'initial_total_value_ada', 'owner'],
      });

      // Batch query: Get all vault values at once
      const allVaultIds = allRelevantVaults.map(v => v.id);
      const allVaultValues = await this.calculateVaultsTvl(allVaultIds);

      // Batch query: Get all snapshots for vaults where users own VT tokens
      const allLockedVaultIds = allRelevantVaults
        .filter(v => VAULT_STATUSES_WITH_VT_TOKENS.includes(v.vault_status))
        .map(v => v.id);
      const allSnapshots =
        allLockedVaultIds.length > 0
          ? await this.snapshotRepository
              .createQueryBuilder('snapshot')
              .distinctOn(['snapshot.vault_id'])
              .where('snapshot.vault_id IN (:...vaultIds)', { vaultIds: allLockedVaultIds })
              .orderBy('snapshot.vault_id', 'ASC')
              .addOrderBy('snapshot.created_at', 'DESC')
              .getMany()
          : [];

      const snapshotByVaultId = new Map(allSnapshots.map(s => [s.vaultId, s]));

      // Batch query: Get all users with their addresses
      const allUsers = await this.userRepository.find({
        where: { id: In([...affectedUserIds]) },
        select: ['id', 'address'],
      });
      const userMap = new Map(allUsers.map(u => [u.id, u]));

      // Batch query: Get all contributed assets for all users and active vaults (contribution/acquire)
      const allActiveVaultIds = allRelevantVaults
        .filter(v => VAULT_STATUSES_WITHOUT_VT_TOKENS.includes(v.vault_status))
        .map(v => v.id);

      const allContributedAssets =
        allActiveVaultIds.length > 0
          ? await this.assetRepository.find({
              where: {
                vault: { id: In(allActiveVaultIds) },
                added_by: { id: In([...affectedUserIds]) },
                status: In([AssetStatus.LOCKED, AssetStatus.DISTRIBUTED, AssetStatus.EXTRACTED]),
                origin_type: AssetOriginType.CONTRIBUTED,
              },
              select: ['vault', 'added_by', 'quantity', 'dex_price', 'floor_price', 'type', 'decimals'],
              relations: ['vault', 'added_by'],
            })
          : [];

      // Group contributed assets by user and vault
      const assetsByUserAndVault = new Map<string, Map<string, typeof allContributedAssets>>();
      allContributedAssets.forEach(asset => {
        const userId = asset.added_by.id;
        const vaultId = asset.vault.id;

        if (!assetsByUserAndVault.has(userId)) {
          assetsByUserAndVault.set(userId, new Map());
        }
        if (!assetsByUserAndVault.get(userId).has(vaultId)) {
          assetsByUserAndVault.get(userId).set(vaultId, []);
        }
        assetsByUserAndVault.get(userId).get(vaultId).push(asset);
      });

      // Calculate TVL and gains for each user
      const userUpdates: Array<{ id: string; tvl: number; gains: number }> = [];

      for (const userId of affectedUserIds) {
        const user = userMap.get(userId);
        if (!user) continue;

        const userTvl = { tvl: 0, gains: 0 };

        // Calculate from all vaults
        for (const vault of allRelevantVaults) {
          const summary = allVaultValues.get(vault.id);
          if (!summary) continue;

          if (VAULT_STATUSES_WITH_VT_TOKENS.includes(vault.vault_status)) {
            // Get user's share from VT token holdings (applies to locked, expansion, and acquire_expansion)
            const snapshot = snapshotByVaultId.get(vault.id);

            if (snapshot?.addressBalances && vault.ft_token_supply) {
              const vtBalance = Number(snapshot.addressBalances[user.address] || 0);
              if (vtBalance > 0) {
                // VT tokens in snapshot are in smallest units (e.g., 1000000 for 1 token with 6 decimals)
                // ft_token_supply might be in human-readable units (e.g., 1 instead of 1000000)
                // We need to normalize both to the same unit using ft_token_decimals
                const decimals = vault.ft_token_decimals || 6; // Default to 6 if not set
                const ftSupplySmallestUnits = Number(vault.ft_token_supply) * Math.pow(10, decimals);

                // Guard against invalid or zero supply to avoid division by zero
                if (!Number.isFinite(ftSupplySmallestUnits) || ftSupplySmallestUnits <= 0) {
                  continue;
                }
                // Now both are in smallest units
                const userShare = vtBalance / ftSupplySmallestUnits;

                // Validate share is reasonable (0-100%)
                if (userShare > 1 || userShare < 0) {
                  continue;
                }

                const userVaultTvl = userShare * summary.totalValueAda;
                userTvl.tvl += userVaultTvl;

                // Calculate proportional gains (including negative)
                if (vault.initial_total_value_ada !== null && vault.initial_total_value_ada !== undefined) {
                  const initialUserValue = userShare * vault.initial_total_value_ada;
                  const vaultGains = userVaultTvl - initialUserValue;
                  userTvl.gains += vaultGains;
                }
              }
            }
          } else if (VAULT_STATUSES_WITHOUT_VT_TOKENS.includes(vault.vault_status)) {
            // Get contributed asset values from pre-loaded data
            const userVaultAssets = assetsByUserAndVault.get(userId)?.get(vault.id);
            if (userVaultAssets) {
              for (const asset of userVaultAssets) {
                userTvl.tvl += asset.valueAda;
              }
            }
          }
        }

        userUpdates.push({ id: userId, tvl: userTvl.tvl, gains: userTvl.gains });
      }

      // Batch update all users
      await Promise.all(
        userUpdates.map(update =>
          this.userRepository.update({ id: update.id }, { tvl: update.tvl, gains: update.gains })
        )
      );
    }
  }

  async getWalletSummaryPaginated(paginationQuery: PaginationQueryDto): Promise<PaginatedWalletSummaryDto> {
    const { address: walletAddress, page, limit, filter, whitelistedPolicies, search, vaultId } = paginationQuery;

    try {
      const adaPriceUsd = await this.priceService.getAdaPrice();

      // Resolve vault to get chain type and custom prices
      const vault = await this.vaultRepository.findOne({ where: { id: vaultId }, select: ['id', 'chain_type'] });
      const { customPrices: customPriceMap, chainlinkFeeds } = vault
        ? await this.getVaultCustomPrices(vault.id)
        : { customPrices: new Map<string, number>(), chainlinkFeeds: new Map<string, EvmPriceFeedConfig>() };

      // Route EVM chains to dedicated handler
      if (vault?.chain_type === ChainType.robinhood) {
        const ethPriceUsd = await this.priceService.getEthPrice();
        return this.getEvmWalletSummaryPaginated(
          paginationQuery,
          customPriceMap,
          chainlinkFeeds,
          adaPriceUsd,
          ethPriceUsd
        );
      }

      // Get overview (cached)
      const overview = await this.getWalletOverview(walletAddress, adaPriceUsd);

      // Get paginated assets
      const { assets, pagination } = await this.getPaginatedAssets(
        walletAddress,
        page,
        limit,
        filter,
        whitelistedPolicies,
        search,
        customPriceMap
      );

      const result = {
        overview,
        assets,
        pagination,
      };

      return plainToInstance(PaginatedWalletSummaryDto, result, {
        excludeExtraneousValues: true,
      });
    } catch (err: any) {
      this.logger.error('Error fetching paginated wallet summary:', err.message);

      if (axios.isAxiosError(err)) {
        if (err.response?.status === 404) {
          throw new HttpException('Wallet address not found', 404);
        }
        throw new HttpException(
          err.response?.data?.message || 'Failed to fetch wallet assets',
          err.response?.status || 500
        );
      }
      throw new HttpException('Failed to fetch or process wallet assets', 500);
    }
  }

  /**
   * Fetch LP token total supply from Blockfrost
   * @param lpTokenUnit - Full LP token unit (policyId + assetName in hex)
   * @returns Total supply or null
   */
  /**
   * Calculate LP token price from VyFi pool data
   * Uses lpQuantity from VyFi API directly (no Blockfrost call needed)
   * @param tokenAUnit - TokenA unit (hex)
   * @param tokenBUnit - TokenB unit (hex or empty for ADA)
   * @param lpTokenUnit - Full LP token unit for logging only
   * @returns LP token price in ADA per normalized unit
   */
  private async calculateLpTokenPriceFromVyFi(
    tokenAUnit: string,
    tokenBUnit: string,
    lpTokenUnit: string
  ): Promise<number | null> {
    if (!this.vyfiService) {
      this.logger.warn('VyfiService not available for LP price calculation');
      return null;
    }

    try {
      // Convert empty tokenB to 'lovelace' for VyFi API
      const tokenBQuery = !tokenBUnit || tokenBUnit === '' ? 'lovelace' : tokenBUnit;

      const poolData = await this.vyfiService.getVyFiPoolData(tokenAUnit, tokenBQuery);
      if (!poolData) {
        this.logger.warn(`No VyFi pool found for ${tokenAUnit}/${tokenBQuery}`);
        return null;
      }

      // Use lpQuantity from VyFi API directly (already in base units)
      const totalSupply = poolData.lpQuantity;
      if (!totalSupply || totalSupply <= 0 || !Number.isSafeInteger(totalSupply)) {
        this.logger.warn(`Invalid/unsafe total supply for LP token ${lpTokenUnit}: ${totalSupply}`);
        return null;
      }

      // VyFi returns quantities in base units, normalize them
      const tokenALocked = poolData.tokenAQuantity;
      const tokenBLocked = poolData.tokenBQuantity;

      // this.logger.debug(
      //   `VyFi pool data - tokenALocked: ${tokenALocked}, tokenBLocked: ${tokenBLocked}, lpSupply: ${totalSupply}`
      // );

      // Get token decimals from Blockfrost
      let tokenADecimals = 6; // Default to 6
      let tokenBDecimals = 6; // Default to 6 (ADA standard)
      let lpTokenDecimals = 0; // Default to 0 for LP tokens

      // LP token decimals - needed to normalize totalSupply
      try {
        const lpTokenMetadata = await this.blockfrost.assetsById(lpTokenUnit);
        lpTokenDecimals = lpTokenMetadata.metadata?.decimals ?? 0;
      } catch (error: any) {
        this.logger.warn(`Failed to fetch LP token decimals for ${lpTokenUnit}, using default 0`);
      }

      // TokenA decimals - skip API call if it's ADA (lovelace)
      const isTokenAAda = tokenAUnit === 'lovelace';
      if (!isTokenAAda) {
        try {
          const tokenAMetadata = await this.blockfrost.assetsById(tokenAUnit);
          tokenADecimals = tokenAMetadata.metadata?.decimals ?? 6;
        } catch (error: any) {
          this.logger.warn(`Failed to fetch decimals for tokenA ${tokenAUnit}, using default 6`);
        }
      }

      // TokenB decimals - skip API call if it's ADA (lovelace)
      const isTokenBAda = !tokenBUnit || tokenBUnit === '' || tokenBUnit === 'lovelace';
      if (!isTokenBAda) {
        try {
          const tokenBMetadata = await this.blockfrost.assetsById(tokenBUnit);
          tokenBDecimals = tokenBMetadata.metadata?.decimals ?? 6;
        } catch (error: any) {
          this.logger.warn(`Failed to fetch decimals for tokenB ${tokenBUnit}, using default 6`);
        }
      }

      // Get token prices
      let tokenAPrice = 0;
      let tokenBPrice = 0;

      // TokenB is ADA if tokenBUnit is empty or 'lovelace'
      if (isTokenBAda) {
        tokenBPrice = 1;
      } else {
        tokenBPrice = (await this.dexHunterPricingService.getTokenPrice(tokenBUnit)) || 0;
      }

      // TokenA price (could be another LP token!)
      tokenAPrice = (await this.dexHunterPricingService.getTokenPrice(tokenAUnit)) || 0;

      // Calculate TVL
      // VyFi returns quantities in base units, normalize using actual decimals from Blockfrost
      const tokenANormalized = tokenALocked / Math.pow(10, tokenADecimals);
      const tokenBNormalized = tokenBLocked / Math.pow(10, tokenBDecimals);

      const tvl = tokenANormalized * tokenAPrice + tokenBNormalized * tokenBPrice;

      // Normalize LP total supply by LP token decimals
      // This converts base units to normalized units for proper price calculation
      const totalSupplyNormalized = totalSupply / Math.pow(10, lpTokenDecimals);
      const lpTokenPrice = tvl / totalSupplyNormalized;

      return lpTokenPrice;
    } catch (error: any) {
      this.logger.error(`Failed to calculate LP price from VyFi: ${error.message}`, error);
      return null;
    }
  }

  /**
   * Calculate LP token price dynamically from pool TVL
   * Formula: LP Token Price = TVL / Total LP Token Supply
   * TVL = (tokenALocked * tokenAPrice) + (tokenBLocked * tokenBPrice)
   *
   * Uses lpTotalSupply from Nexus API directly (no Blockfrost call needed)
   * Falls back to VyFi API if pool ID format indicates VyFi pool
   *
   * @param onchainID - Pool onchain ID (can be VyFi onchain ID format)
   * @param lpTokenUnit - Optional: Full LP token unit to enable VyFi fallback
   * @returns LP token price in ADA per normalized unit
   */
  private async calculateLpTokenPrice(onchainID: string, lpTokenUnit?: string): Promise<number | null> {
    try {
      const poolData = await this.tapToolsClient.getPoolByOnchainId(onchainID);
      if (!poolData || !poolData.lpTokenUnit) {
        // VyFi fallback: when onchainID is encoded as "tokenAUnit:tokenBUnit"
        if (lpTokenUnit && this.vyfiService && onchainID.includes(':')) {
          this.logger.debug('Attempting VyFi fallback for LP price calculation');
          const [tokenAUnit, tokenBUnit] = onchainID.split(':');
          return this.calculateLpTokenPriceFromVyFi(tokenAUnit, tokenBUnit || '', lpTokenUnit);
        }

        return null;
      }

      // Use lpTotalSupply from Nexus API directly (already fetched with pool data)
      const totalSupply = poolData.lpTotalSupply;
      if (!totalSupply || totalSupply <= 0) {
        this.logger.warn(
          `No valid total supply in pool data for LP token ${poolData.lpTokenUnit} (onchainID: ${onchainID})`
        );
        return null;
      }

      let tokenAPrice = 0;
      let tokenBPrice = 0;

      if (poolData.tokenATicker === 'ADA' || !poolData.tokenA || poolData.tokenA === '') {
        tokenAPrice = 1;
      } else {
        tokenAPrice = (await this.dexHunterPricingService.getTokenPrice(poolData.tokenA)) || 0;
      }

      if (poolData.tokenBTicker === 'ADA' || !poolData.tokenB || poolData.tokenB === '') {
        tokenBPrice = 1;
      } else {
        tokenBPrice = (await this.dexHunterPricingService.getTokenPrice(poolData.tokenB)) || 0;
      }

      // DexHunter/Nexus returns NORMALIZED (human-readable) token amounts
      // tokenALocked and tokenBLocked are already normalized
      // lpTotalSupply might be in base units, so fetch decimals and normalize
      let lpTokenDecimals = 0;
      try {
        const lpTokenMetadata = await this.blockfrost.assetsById(poolData.lpTokenUnit);
        lpTokenDecimals = lpTokenMetadata.metadata?.decimals ?? 0;
      } catch (error: any) {
        this.logger.warn(`Failed to fetch LP token decimals for ${poolData.lpTokenUnit}, using default 0`);
      }

      const tvl = poolData.tokenALocked * tokenAPrice + poolData.tokenBLocked * tokenBPrice;
      const totalSupplyNormalized = totalSupply / Math.pow(10, lpTokenDecimals);
      const lpTokenPrice = tvl / totalSupplyNormalized;

      this.logger.debug(
        `Nexus LP price calculation for ${poolData.lpTokenUnit} - ` +
          `TVL: ${tvl.toFixed(2)} ADA, ` +
          `LP supply: ${totalSupply} base units (${totalSupplyNormalized} normalized, decimals: ${lpTokenDecimals}), ` +
          `LP price: ${lpTokenPrice.toFixed(10)} ADA per normalized LP token`
      );

      return lpTokenPrice;
    } catch (error: any) {
      this.logger.error(`Failed to calculate LP token price for ${onchainID}`, error);
      return null;
    }
  }

  /**
   * Get custom prices from vault asset whitelist
   * Returns a Map of policyId -> customPriceAda
   * Includes assets with valuation_method = 'custom' and 'lp_token_dynamic'
   * @param vaultId The ID of the vault
   * @returns Map of policy IDs to custom prices in ADA
   */
  private async getVaultCustomPrices(
    vaultId: string
  ): Promise<{ customPrices: CustomPriceMap; chainlinkFeeds: EvmPriceFeedsMap }> {
    const customPrices: CustomPriceMap = new Map();
    const chainlinkFeeds: EvmPriceFeedsMap = new Map();

    try {
      const vault = await this.vaultRepository.findOne({
        where: { id: vaultId },
        relations: ['assets_whitelist'],
      });

      if (!vault || !vault.assets_whitelist) {
        return { customPrices, chainlinkFeeds };
      }

      // Collect all EVM contract addresses from the whitelist to fetch their feeds in one query
      const evmAddresses = vault.assets_whitelist
        .map(w => w.policy_id)
        .filter(p => /^0x[0-9a-fA-F]{40}$/.test(p))
        .map(p => p.toLowerCase());

      if (evmAddresses.length > 0) {
        const chainId = this.configService.get<number>('EVM_CHAIN_ID') ?? 46630;
        const feeds = await this.evmPriceFeedRepository.find({
          where: { chain_id: chainId, enabled: true, token_address: In(evmAddresses) },
          select: ['token_address', 'chainlink_feed_address', 'max_age_seconds', 'allow_dexscreener_fallback'],
        });
        for (const feed of feeds) {
          chainlinkFeeds.set(feed.token_address.toLowerCase(), {
            feedAddress: feed.chainlink_feed_address.toLowerCase(),
            maxAgeSeconds: feed.max_age_seconds,
            allowDexscreenerFallback: feed.allow_dexscreener_fallback,
          });
        }
      }

      for (const whitelistItem of vault.assets_whitelist) {
        // Handle static custom pricing
        if (whitelistItem.valuation_method === AssetValuationMethod.CUSTOM && whitelistItem.custom_price_ada) {
          customPrices.set(whitelistItem.policy_id, Number(whitelistItem.custom_price_ada));
        }

        // Handle dynamic LP token pricing
        if (
          whitelistItem.valuation_method === AssetValuationMethod.LP_TOKEN_DYNAMIC &&
          whitelistItem.lp_pool_onchain_id
        ) {
          let lpPrice: number | null = null;

          // Check if this is a VyFi pool (format: tokenA:tokenB)
          if (whitelistItem.lp_pool_onchain_id.includes(':')) {
            // VyFi LP token: parse tokenA and tokenB from colon-separated format
            const [tokenAUnit, tokenBUnit] = whitelistItem.lp_pool_onchain_id.split(':');

            // Get the full LP token unit from assets table
            const lpAsset = await this.assetRepository.findOne({
              where: {
                vault_id: vaultId,
                policy_id: whitelistItem.policy_id,
              },
            });

            if (lpAsset) {
              const lpTokenUnit = lpAsset.policy_id + lpAsset.asset_id;

              lpPrice = await this.calculateLpTokenPriceFromVyFi(tokenAUnit, tokenBUnit || '', lpTokenUnit);
            } else {
              // Asset not in vault yet - skip silently (this is expected for whitelisted assets not yet deposited)
              continue;
            }
          } else {
            // TapTools LP token: use onchainID directly
            lpPrice = await this.calculateLpTokenPrice(whitelistItem.lp_pool_onchain_id);
          }

          if (lpPrice !== null && lpPrice !== undefined && Number.isFinite(lpPrice)) {
            customPrices.set(whitelistItem.policy_id, lpPrice);
          } else {
            this.logger.debug(
              `Failed to calculate LP price for ${whitelistItem.policy_id} - asset may not be deposited yet`
            );
          }
        }
      }

      return { customPrices, chainlinkFeeds };
    } catch (error: any) {
      this.logger.error(`Failed to load custom prices for vault ${vaultId}:`, error.message);
      return { customPrices, chainlinkFeeds };
    }
  }

  // ---------------------------------------------------------------------------
  // EVM (Robinhood chain) wallet asset fetching
  // ---------------------------------------------------------------------------

  /**
   * Resolve the ADA price for an EVM asset.
   *
   * Priority:
   *   1. Custom price from vault whitelist (always wins)
   *   2. Testnet: mock price from env (EVM_TESTNET_NFT/FT_PRICE_ADA) or 1 ADA
   *   3. Mainnet: Chainlink on-chain feed (evm_asset_price_feeds DB) → DexScreener → null
   *
   * DEXSCREENER_CHAIN_ID env: DexScreener chain slug (e.g. "robinhood").
   * Staleness limit and DexScreener fallback flag come from evm_asset_price_feeds rows.
   */
  private async getEvmPriceAda(
    contractAddress: string,
    customPriceMap: CustomPriceMap,
    chainlinkFeeds: EvmPriceFeedsMap,
    isNft: boolean,
    adaPriceUsd: number
  ): Promise<number | null> {
    // 1. Vault-specific custom price
    const contractKey = contractAddress.toLowerCase();
    const custom = customPriceMap.get(contractKey) ?? customPriceMap.get(contractAddress);
    if (custom !== undefined) return custom;

    // 2. Testnet mock
    if (!this.isMainnet) {
      const envKey = isNft ? 'EVM_TESTNET_NFT_PRICE_ADA' : 'EVM_TESTNET_FT_PRICE_ADA';
      const envPrice = this.configService.get<number>(envKey);
      return envPrice ?? 1;
    }

    // 3. Mainnet — Chainlink feed from evm_asset_price_feeds DB table
    const feedConfig = chainlinkFeeds.get(contractKey);
    if (feedConfig) {
      const client = this.getEvmPublicClient();
      const priceUsd = await this.getChainlinkPriceUsd(feedConfig.feedAddress, client, feedConfig.maxAgeSeconds);
      if (priceUsd !== null && adaPriceUsd > 0) return priceUsd / adaPriceUsd;

      if (!feedConfig.allowDexscreenerFallback) return null;
    }

    // 4. Mainnet — DexScreener fallback
    const dexPriceUsd = await this.getDexScreenerPriceUsd(contractAddress);
    if (dexPriceUsd !== null && adaPriceUsd > 0) return dexPriceUsd / adaPriceUsd;

    return null;
  }

  /**
   * Read USD price from a Chainlink AggregatorV3 feed proxy via viem.
   * Validates answer > 0 and staleness. Returns null on any failure.
   */
  private async getChainlinkPriceUsd(
    feedProxyAddress: string,
    client: any,
    maxAgeSeconds: number
  ): Promise<number | null> {
    try {
      const [roundData, decimals] = await Promise.all([
        client.readContract({
          address: feedProxyAddress as Address,
          abi: CHAINLINK_AGGREGATOR_ABI,
          functionName: 'latestRoundData',
        }),
        client.readContract({
          address: feedProxyAddress as Address,
          abi: CHAINLINK_AGGREGATOR_ABI,
          functionName: 'decimals',
        }),
      ]);

      const [, answer, , updatedAt] = roundData as [bigint, bigint, bigint, bigint, bigint];
      if (answer <= 0n) return null;

      const ageSeconds = Math.floor(Date.now() / 1000) - Number(updatedAt);
      if (ageSeconds > maxAgeSeconds) {
        this.logger.warn(`Chainlink feed ${feedProxyAddress} is stale (${ageSeconds}s old, max ${maxAgeSeconds}s)`);
        return null;
      }

      return Number(answer) / Math.pow(10, Number(decimals));
    } catch (err: any) {
      this.logger.warn(`Chainlink price read failed for ${feedProxyAddress}: ${err?.message}`);
      return null;
    }
  }

  /**
   * Fetch USD price from DexScreener for an EVM token.
   * Uses DEXSCREENER_CHAIN_ID env (default: "robinhood"). Picks the pair
   * with the highest USD liquidity to avoid illiquid/stale quotes.
   * Returns null when the token has no listed pair or the call fails.
   */
  private async getDexScreenerPriceUsd(contractAddress: string): Promise<number | null> {
    try {
      const chainId = this.configService.get<string>('DEXSCREENER_CHAIN_ID') ?? 'robinhood';
      const url = `https://api.dexscreener.com/tokens/v1/${chainId}/${contractAddress}`;
      const response = await axios.get(url, { timeout: 5_000 });
      const pairs: any[] = Array.isArray(response.data) ? response.data : [];

      const best = pairs
        .filter(p => p.priceUsd && parseFloat(p.priceUsd) > 0)
        .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];

      return best ? parseFloat(best.priceUsd) : null;
    } catch (err: any) {
      this.logger.warn(`DexScreener price fetch failed for ${contractAddress}: ${err?.message}`);
      return null;
    }
  }

  /**
   * Fetch token metadata JSON from a tokenURI / ERC-1155 uri string.
   * Handles ipfs:// and http(s):// URIs. Returns null on any failure.
   *
   * NOTE: Alchemy's NFT API (getNFTsForOwner) supports rich metadata but only for
   * chains Alchemy indexes (Ethereum, Polygon, Arbitrum, Base, etc.). Robinhood
   * testnet is a custom chain and is NOT indexed by Alchemy, so we fetch metadata
   * directly from tokenURI here. If you later add Alchemy Custom Network support,
   * replace this with an Alchemy getNFTsForOwner call.
   */
  private async fetchEvmNftMetadata(tokenUri: string): Promise<{
    name?: string;
    description?: string;
    image?: string;
    attributes?: Array<{ trait_type?: string; value?: string | number }>;
  } | null> {
    if (!tokenUri) return null;
    try {
      let url = tokenUri;
      if (tokenUri.startsWith('ipfs://')) {
        const ipfsGateway = this.configService.get<string>('IPFS_GATEWAY') ?? 'https://ipfs.io/ipfs/';
        url = ipfsGateway + tokenUri.slice(7);
      } else if (!tokenUri.startsWith('http')) {
        return null;
      }
      const response = await axios.get(url, { timeout: 5000 });
      if (response.data && typeof response.data === 'object') return response.data;
      return null;
    } catch {
      return null;
    }
  }

  private getEvmPublicClient(): ReturnType<typeof createPublicClient> {
    const evmRpcUrl = this.configService.get<string>('EVM_RPC_URL');
    if (!evmRpcUrl) {
      throw new HttpException('EVM RPC URL not configured', 500);
    }
    const chainId = this.configService.get<number>('EVM_CHAIN_ID', 46630);
    const robinhoodChain = defineChain({
      id: chainId,
      name: 'Robinhood',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [evmRpcUrl] } },
    });
    return createPublicClient({ chain: robinhoodChain, transport: http(evmRpcUrl) });
  }

  /**
   * Detect whether a contract is ERC721, ERC1155, or ERC20 via ERC-165.
   * Falls back to ERC20 if supportsInterface is not available.
   */
  private async detectEvmContractType(client: any, contractAddress: string): Promise<'ERC721' | 'ERC1155' | 'ERC20'> {
    try {
      const [isErc721, isErc1155] = await Promise.all([
        client
          .readContract({
            address: contractAddress as Address,
            abi: ERC165_ABI,
            functionName: 'supportsInterface',
            args: [ERC721_INTERFACE_ID],
          })
          .catch(() => false),
        client
          .readContract({
            address: contractAddress as Address,
            abi: ERC165_ABI,
            functionName: 'supportsInterface',
            args: [ERC1155_INTERFACE_ID],
          })
          .catch(() => false),
      ]);

      if (isErc721) return 'ERC721';
      if (isErc1155) return 'ERC1155';
      return 'ERC20';
    } catch {
      return 'ERC20';
    }
  }

  private async getErc20Asset(
    client: any,
    contractAddress: string,
    walletAddress: string,
    customPriceMap: CustomPriceMap,
    chainlinkFeeds: EvmPriceFeedsMap,
    adaPriceUsd: number,
    ethPriceUsd: number
  ): Promise<AssetValueDto | null> {
    try {
      const addr = contractAddress as Address;
      const wallet = walletAddress as Address;

      const [rawBalance, name, symbol, decimals] = await Promise.all([
        client
          .readContract({ address: addr, abi: ERC20_ABI, functionName: 'balanceOf', args: [wallet] })
          .catch(() => 0n),
        client.readContract({ address: addr, abi: ERC20_ABI, functionName: 'name' }).catch(() => contractAddress),
        client.readContract({ address: addr, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => ''),
        client.readContract({ address: addr, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18),
      ]);

      const rawQuantity = Number(rawBalance);
      const decimalAdjustedBalance = rawQuantity / Math.pow(10, Number(decimals));
      if (decimalAdjustedBalance <= 0) return null;

      const priceAda = await this.getEvmPriceAda(contractAddress, customPriceMap, chainlinkFeeds, false, adaPriceUsd);
      if (priceAda === null) return null;
      const priceUsd = priceAda * adaPriceUsd;
      const priceEth = ethPriceUsd > 0 ? priceUsd / ethPriceUsd : 0;

      const dto: AssetValueDto = plainToInstance(
        AssetValueDto,
        {
          tokenId: contractAddress,
          name: String(name),
          displayName: String(name),
          ticker: String(symbol),
          quantity: rawQuantity, // Return raw quantity, not decimal-adjusted
          isNft: false,
          isFungibleToken: true,
          priceAda,
          priceUsd,
          priceEth,
          valueAda: +(decimalAdjustedBalance * priceAda).toFixed(6),
          valueUsd: +(decimalAdjustedBalance * priceUsd).toFixed(6),
          valueEth: +(decimalAdjustedBalance * priceEth).toFixed(6),
          metadata: {
            policyId: contractAddress,
            decimals: Number(decimals),
          },
        },
        { excludeExtraneousValues: true }
      );

      return dto;
    } catch (err: any) {
      this.logger.warn(`Failed to fetch ERC20 asset ${contractAddress}: ${err.message}`);
      return null;
    }
  }

  private async getErc721Assets(
    client: any,
    contractAddress: string,
    walletAddress: string,
    customPriceMap: CustomPriceMap,
    chainlinkFeeds: EvmPriceFeedsMap,
    adaPriceUsd: number,
    ethPriceUsd: number
  ): Promise<AssetValueDto[]> {
    try {
      const addr = contractAddress as Address;
      const wallet = walletAddress as Address;

      const [balance, collectionName, symbol] = await Promise.all([
        client
          .readContract({ address: addr, abi: ERC721_ABI, functionName: 'balanceOf', args: [wallet] })
          .catch(() => 0n),
        client.readContract({ address: addr, abi: ERC721_ABI, functionName: 'name' }).catch(() => contractAddress),
        client.readContract({ address: addr, abi: ERC721_ABI, functionName: 'symbol' }).catch(() => ''),
      ]);

      const count = Number(balance);
      if (count === 0) return [];

      // Enumerate token IDs via tokenOfOwnerByIndex (ERC721Enumerable)
      const indexCalls = Array.from({ length: count }, (_, i) => ({
        address: addr,
        abi: ERC721_ABI,
        functionName: 'tokenOfOwnerByIndex' as const,
        args: [wallet, BigInt(i)] as [Address, bigint],
      }));

      const indexResults = await client.multicall({ contracts: indexCalls, allowFailure: true });

      const tokenIds: bigint[] = indexResults.filter(r => r.status === 'success').map(r => r.result as bigint);

      if (tokenIds.length === 0) {
        this.logger.warn(`ERC721 ${contractAddress}: tokenOfOwnerByIndex not available, cannot enumerate tokens`);
        return [];
      }

      const priceAda = await this.getEvmPriceAda(contractAddress, customPriceMap, chainlinkFeeds, true, adaPriceUsd);
      if (priceAda === null) return [];
      const priceUsd = priceAda * adaPriceUsd;
      const priceEth = ethPriceUsd > 0 ? priceUsd / ethPriceUsd : 0;

      // Fetch tokenURIs for metadata enrichment (name / image / attributes)
      const uriCalls = tokenIds.map(id => ({
        address: addr,
        abi: ERC721_ABI,
        functionName: 'tokenURI' as const,
        args: [id] as [bigint],
      }));
      const uriResults = await client.multicall({ contracts: uriCalls, allowFailure: true });
      const metadataList = await Promise.all(
        uriResults.map(r => (r.status === 'success' ? this.fetchEvmNftMetadata(r.result as string) : null))
      );

      const assets: AssetValueDto[] = tokenIds.map((tokenId, i) => {
        const tokenIdStr = tokenId.toString();
        const meta = metadataList[i];
        return plainToInstance(
          AssetValueDto,
          {
            tokenId: `${contractAddress}_${tokenIdStr}`,
            name: meta?.name ?? `${String(collectionName)} #${tokenIdStr}`,
            displayName: meta?.name ?? `${String(collectionName)} #${tokenIdStr}`,
            ticker: String(symbol),
            quantity: 1,
            isNft: true,
            isFungibleToken: false,
            priceAda,
            priceUsd,
            priceEth,
            valueAda: priceAda,
            valueUsd: priceUsd,
            valueEth: priceEth,
            metadata: {
              policyId: contractAddress,
              assetName: tokenIdStr,
              image: meta?.image,
              description: meta?.description,
              attributes: meta?.attributes,
              onchainMetadata: { tokenId: tokenIdStr, ...(meta ?? {}) },
            },
          },
          { excludeExtraneousValues: true }
        );
      });

      return assets;
    } catch (err: any) {
      this.logger.warn(`Failed to fetch ERC721 assets for ${contractAddress}: ${err.message}`);
      return [];
    }
  }

  private async getErc1155Assets(
    client: any,
    contractAddress: string,
    walletAddress: string,
    customPriceMap: CustomPriceMap,
    chainlinkFeeds: EvmPriceFeedsMap,
    adaPriceUsd: number,
    ethPriceUsd: number
  ): Promise<AssetValueDto[]> {
    try {
      const addr = contractAddress as Address;
      const wallet = walletAddress as Address;

      // Discover token IDs via TransferSingle and TransferBatch event logs
      const [singleLogs, batchLogs] = await Promise.all([
        client
          .getLogs({
            address: addr,
            topics: [ERC1155_TRANSFER_SINGLE_TOPIC, null, null, wallet as any],
            fromBlock: 0n,
            toBlock: 'latest',
          })
          .catch(() => []),
        client
          .getLogs({
            address: addr,
            topics: [ERC1155_TRANSFER_BATCH_TOPIC, null, null, wallet as any],
            fromBlock: 0n,
            toBlock: 'latest',
          })
          .catch(() => []),
      ]);

      const tokenIdSet = new Set<bigint>();

      // Parse TransferSingle: data = abi.encode(uint256 id, uint256 value)
      for (const log of singleLogs) {
        if (log.data && log.data !== '0x') {
          const id = BigInt('0x' + log.data.slice(2, 66));
          tokenIdSet.add(id);
        }
      }

      // Parse TransferBatch: data = abi.encode(uint256[] ids, uint256[] values)
      for (const log of batchLogs) {
        if (log.data && log.data !== '0x') {
          const data = log.data.slice(2); // strip 0x
          // offset for ids array is in first 32 bytes, but since it's the first param it starts at 0x40
          const idsOffset = parseInt(data.slice(0, 64), 16) * 2;
          const idsLength = parseInt(data.slice(idsOffset, idsOffset + 64), 16);
          for (let i = 0; i < idsLength; i++) {
            const id = BigInt('0x' + data.slice(idsOffset + 64 + i * 64, idsOffset + 64 + (i + 1) * 64));
            tokenIdSet.add(id);
          }
        }
      }

      if (tokenIdSet.size === 0) return [];

      // Batch check current balances
      const tokenIds = Array.from(tokenIdSet);
      const balanceCalls = tokenIds.map(id => ({
        address: addr,
        abi: ERC1155_ABI,
        functionName: 'balanceOf' as const,
        args: [wallet, id] as [Address, bigint],
      }));

      const balanceResults = await client.multicall({ contracts: balanceCalls, allowFailure: true });

      const priceAda = await this.getEvmPriceAda(contractAddress, customPriceMap, chainlinkFeeds, true, adaPriceUsd);
      if (priceAda === null) return [];
      const priceUsd = priceAda * adaPriceUsd;
      const priceEth = ethPriceUsd > 0 ? priceUsd / ethPriceUsd : 0;

      // Fetch ERC-1155 uris for metadata enrichment
      const uriCalls1155 = tokenIds.map(id => ({
        address: addr,
        abi: ERC1155_ABI,
        functionName: 'uri' as const,
        args: [id] as [bigint],
      }));
      const uriResults1155 = await client.multicall({ contracts: uriCalls1155, allowFailure: true });
      const metadataList1155 = await Promise.all(
        uriResults1155.map((r, i) => {
          if (r.status !== 'success') return null;
          // ERC-1155 uri may contain {id} template — replace with zero-padded hex
          const raw = r.result as string;
          const hexId = tokenIds[i].toString(16).padStart(64, '0');
          return this.fetchEvmNftMetadata(raw.replace('{id}', hexId));
        })
      );

      const assets: AssetValueDto[] = [];
      for (let i = 0; i < tokenIds.length; i++) {
        const result = balanceResults[i];
        if (result.status !== 'success') continue;

        const qty = Number(result.result as bigint);
        if (qty <= 0) continue;

        const tokenIdStr = tokenIds[i].toString();
        const meta = metadataList1155[i];
        assets.push(
          plainToInstance(
            AssetValueDto,
            {
              tokenId: `${contractAddress}_${tokenIdStr}`,
              name: meta?.name ?? `Token #${tokenIdStr}`,
              displayName: meta?.name ?? `Token #${tokenIdStr}`,
              quantity: qty,
              isNft: true,
              isFungibleToken: false,
              priceAda,
              priceUsd,
              priceEth,
              valueAda: +(qty * priceAda).toFixed(6),
              valueUsd: +(qty * priceUsd).toFixed(6),
              valueEth: +(qty * priceEth).toFixed(6),
              metadata: {
                policyId: contractAddress,
                assetName: tokenIdStr,
                image: meta?.image,
                description: meta?.description,
                attributes: meta?.attributes,
                onchainMetadata: { tokenId: tokenIdStr, ...(meta ?? {}) },
              },
            },
            { excludeExtraneousValues: true }
          )
        );
      }

      return assets;
    } catch (err: any) {
      this.logger.warn(`Failed to fetch ERC1155 assets for ${contractAddress}: ${err.message}`);
      return [];
    }
  }

  /**
   * Get paginated wallet summary for EVM (Robinhood) chain.
   * Uses Alchemy APIs (NFT + Token) when ALCHEMY_API_KEY is configured,
   * falls back to direct RPC enumeration otherwise.
   *
   * Alchemy network names for Robinhood:
   *   testnet → robinhood-testnet   (set ALCHEMY_NETWORK=robinhood-testnet)
   *   mainnet → robinhood-mainnet   (set ALCHEMY_NETWORK=robinhood-mainnet)
   */
  private async getEvmWalletSummaryPaginated(
    paginationQuery: PaginationQueryDto,
    customPriceMap: CustomPriceMap,
    chainlinkFeeds: EvmPriceFeedsMap,
    adaPriceUsd: number,
    ethPriceUsd: number
  ): Promise<PaginatedWalletSummaryDto> {
    const alchemyKey = this.configService.get<string>('ALCHEMY_API_KEY');
    const alchemyNetwork = this.configService.get<string>('ALCHEMY_NETWORK', 'robinhood-testnet');

    if (alchemyKey) {
      try {
        return await this.getEvmWalletSummaryViaAlchemy(
          paginationQuery,
          customPriceMap,
          chainlinkFeeds,
          adaPriceUsd,
          ethPriceUsd,
          alchemyKey,
          alchemyNetwork
        );
      } catch (err: any) {
        this.logger.warn(`Alchemy EVM wallet summary failed, falling back to RPC: ${err.message}`);
      }
    }

    return this.getEvmWalletSummaryViaRpc(paginationQuery, customPriceMap, chainlinkFeeds, adaPriceUsd, ethPriceUsd);
  }

  // ---------------------------------------------------------------------------
  // Alchemy-based EVM wallet asset fetching
  // ---------------------------------------------------------------------------

  /**
   * Fetch NFTs (ERC721 + ERC1155) owned by a wallet via Alchemy NFT API.
   * Returns fully enriched AssetValueDto array including metadata.
   */
  private async fetchAlchemyNfts(
    apiKey: string,
    network: string,
    walletAddress: string,
    contracts: string[],
    customPriceMap: CustomPriceMap,
    chainlinkFeeds: EvmPriceFeedsMap,
    adaPriceUsd: number,
    ethPriceUsd: number
  ): Promise<AssetValueDto[]> {
    const nftBase = `https://${network}.g.alchemy.com/nft/v3/${apiKey}`;
    const contractParams = contracts.map(c => `contractAddresses[]=${encodeURIComponent(c)}`).join('&');
    const url = `${nftBase}/getNFTsForOwner?owner=${encodeURIComponent(walletAddress)}&${contractParams}&withMetadata=true&pageSize=100`;

    const response = await axios.get(url, { timeout: 10_000 });
    const ownedNfts: any[] = response.data?.ownedNfts ?? [];

    return (
      await Promise.all(
        ownedNfts.map(async nft => {
          const contractAddress: string = nft.contract?.address ?? '';
          const tokenId: string = nft.tokenId ?? '0';
          const qty = parseInt(nft.balance ?? '1', 10) || 1;

          const priceAda = await this.getEvmPriceAda(
            contractAddress,
            customPriceMap,
            chainlinkFeeds,
            true,
            adaPriceUsd
          );
          if (priceAda === null) return null;
          const priceUsd = priceAda * adaPriceUsd;
          const priceEth = ethPriceUsd > 0 ? priceUsd / ethPriceUsd : 0;

          const name = nft.name ?? `${nft.contract?.name ?? contractAddress} #${tokenId}`;
          const image = nft.image?.cachedUrl ?? nft.image?.originalUrl ?? nft.raw?.metadata?.image ?? undefined;

          return plainToInstance(
            AssetValueDto,
            {
              tokenId: `${contractAddress}_${tokenId}`,
              name,
              displayName: name,
              ticker: nft.contract?.symbol ?? undefined,
              quantity: qty,
              isNft: true,
              isFungibleToken: false,
              priceAda,
              priceUsd,
              priceEth,
              valueAda: +(qty * priceAda).toFixed(6),
              valueUsd: +(qty * priceUsd).toFixed(6),
              valueEth: +(qty * priceEth).toFixed(6),
              metadata: {
                policyId: contractAddress,
                assetName: tokenId,
                image,
                description: nft.description ?? nft.raw?.metadata?.description ?? undefined,
                attributes: nft.raw?.metadata?.attributes ?? undefined,
                onchainMetadata: {
                  tokenId,
                  tokenType: nft.tokenType,
                  ...(nft.raw?.metadata ?? {}),
                },
              },
            },
            { excludeExtraneousValues: true }
          );
        })
      )
    ).filter((a): a is AssetValueDto => a !== null);
  }

  /**
   * Fetch ERC20 token balances + metadata via Alchemy Token API.
   * Skips contracts that are known NFT contracts (already fetched).
   */
  private async fetchAlchemyErc20s(
    apiKey: string,
    network: string,
    walletAddress: string,
    contracts: string[],
    customPriceMap: CustomPriceMap,
    chainlinkFeeds: EvmPriceFeedsMap,
    adaPriceUsd: number,
    ethPriceUsd: number
  ): Promise<AssetValueDto[]> {
    const rpcBase = `https://${network}.g.alchemy.com/v2/${apiKey}`;

    // Batch-fetch balances
    const balanceRes = await axios.post(
      rpcBase,
      { jsonrpc: '2.0', method: 'alchemy_getTokenBalances', params: [walletAddress, contracts], id: 1 },
      { timeout: 10_000 }
    );

    const tokenBalances: Array<{ contractAddress: string; tokenBalance: string }> =
      balanceRes.data?.result?.tokenBalances ?? [];

    const nonZero = tokenBalances.filter(tb => {
      try {
        return BigInt(tb.tokenBalance ?? '0x0') > 0n;
      } catch {
        return false;
      }
    });

    if (nonZero.length === 0) return [];

    // Fetch metadata for each non-zero token concurrently
    const withMeta = await Promise.all(
      nonZero.map(async tb => {
        try {
          const metaRes = await axios.post(
            rpcBase,
            { jsonrpc: '2.0', method: 'alchemy_getTokenMetadata', params: [tb.contractAddress], id: 1 },
            { timeout: 5_000 }
          );
          return { ...tb, meta: metaRes.data?.result ?? {} };
        } catch {
          return { ...tb, meta: {} };
        }
      })
    );

    return (
      await Promise.all(
        withMeta.map(async ({ contractAddress, tokenBalance, meta }) => {
          const decimals: number = meta?.decimals ?? 18;
          let rawQuantity = 0;
          let decimalAdjustedBalance = 0;
          try {
            // Convert hex string to raw decimal number
            rawQuantity = Number(BigInt(tokenBalance));
            // Calculate human-readable balance for value computation
            decimalAdjustedBalance = rawQuantity / Math.pow(10, decimals);
          } catch {
            return null;
          }
          if (decimalAdjustedBalance <= 0) return null;

          const priceAda = await this.getEvmPriceAda(
            contractAddress,
            customPriceMap,
            chainlinkFeeds,
            false,
            adaPriceUsd
          );
          if (priceAda === null) return null;
          const priceUsd = priceAda * adaPriceUsd;
          const priceEth = ethPriceUsd > 0 ? priceUsd / ethPriceUsd : 0;

          return plainToInstance(
            AssetValueDto,
            {
              tokenId: contractAddress,
              name: meta?.name ?? contractAddress,
              displayName: meta?.name ?? contractAddress,
              ticker: meta?.symbol ?? undefined,
              quantity: rawQuantity, // Return raw quantity as number, not hex string
              isNft: false,
              isFungibleToken: true,
              priceAda,
              priceUsd,
              priceEth,
              valueAda: +(decimalAdjustedBalance * priceAda).toFixed(6),
              valueUsd: +(decimalAdjustedBalance * priceUsd).toFixed(6),
              valueEth: +(decimalAdjustedBalance * priceEth).toFixed(6),
              metadata: {
                policyId: contractAddress,
                decimals,
                image: meta?.logo ?? undefined,
              },
            },
            { excludeExtraneousValues: true }
          );
        })
      )
    ).filter((a): a is AssetValueDto => a !== null);
  }

  /** Alchemy-based implementation of EVM wallet summary. */
  private async getEvmWalletSummaryViaAlchemy(
    paginationQuery: PaginationQueryDto,
    customPriceMap: CustomPriceMap,
    chainlinkFeeds: EvmPriceFeedsMap,
    adaPriceUsd: number,
    ethPriceUsd: number,
    apiKey: string,
    network: string
  ): Promise<PaginatedWalletSummaryDto> {
    const { address: walletAddress, page, limit, filter, whitelistedPolicies, search } = paginationQuery;
    const contracts = whitelistedPolicies ?? [];
    const allAssets: AssetValueDto[] = [];

    // --- NFTs (ERC721 + ERC1155) ---
    if (filter !== 'tokens' && contracts.length > 0) {
      const nfts = await this.fetchAlchemyNfts(
        apiKey,
        network,
        walletAddress,
        contracts,
        customPriceMap,
        chainlinkFeeds,
        adaPriceUsd,
        ethPriceUsd
      );
      allAssets.push(...nfts);
    }

    // --- ERC20 tokens: skip contracts that already returned NFTs ---
    if (filter !== 'nfts' && contracts.length > 0) {
      const nftContractSet = new Set(allAssets.map(a => (a.metadata?.policyId ?? '').toLowerCase()));
      const erc20Candidates =
        filter === 'tokens' ? contracts : contracts.filter(c => !nftContractSet.has(c.toLowerCase()));

      if (erc20Candidates.length > 0) {
        const tokens = await this.fetchAlchemyErc20s(
          apiKey,
          network,
          walletAddress,
          erc20Candidates,
          customPriceMap,
          chainlinkFeeds,
          adaPriceUsd,
          ethPriceUsd
        );
        allAssets.push(...tokens);
      }
    }

    return this.buildEvmPaginatedResponse(walletAddress, allAssets, page, limit, search);
  }

  /** Direct-RPC fallback for EVM wallet summary (used when Alchemy is not configured). */
  private async getEvmWalletSummaryViaRpc(
    paginationQuery: PaginationQueryDto,
    customPriceMap: CustomPriceMap,
    chainlinkFeeds: EvmPriceFeedsMap,
    adaPriceUsd: number,
    ethPriceUsd: number
  ): Promise<PaginatedWalletSummaryDto> {
    const { address: walletAddress, page, limit, filter, whitelistedPolicies, search } = paginationQuery;

    const client = this.getEvmPublicClient();
    const allAssets: AssetValueDto[] = [];

    for (const contractAddress of whitelistedPolicies ?? []) {
      const contractType = await this.detectEvmContractType(client, contractAddress);

      if (contractType === 'ERC721' && filter !== 'tokens') {
        const nfts = await this.getErc721Assets(
          client,
          contractAddress,
          walletAddress,
          customPriceMap,
          chainlinkFeeds,
          adaPriceUsd,
          ethPriceUsd
        );
        allAssets.push(...nfts);
      } else if (contractType === 'ERC1155' && filter !== 'tokens') {
        const tokens = await this.getErc1155Assets(
          client,
          contractAddress,
          walletAddress,
          customPriceMap,
          chainlinkFeeds,
          adaPriceUsd,
          ethPriceUsd
        );
        allAssets.push(...tokens);
      } else if (contractType === 'ERC20' && filter !== 'nfts') {
        const token = await this.getErc20Asset(
          client,
          contractAddress,
          walletAddress,
          customPriceMap,
          chainlinkFeeds,
          adaPriceUsd,
          ethPriceUsd
        );
        if (token) allAssets.push(token);
      }
    }

    return this.buildEvmPaginatedResponse(walletAddress, allAssets, page, limit, search);
  }

  /** Shared helper: search + paginate + wrap into PaginatedWalletSummaryDto. */
  private buildEvmPaginatedResponse(
    walletAddress: string,
    allAssets: AssetValueDto[],
    page: number,
    limit: number,
    search?: string
  ): PaginatedWalletSummaryDto {
    const filtered = search
      ? allAssets.filter(
          a =>
            a.name.toLowerCase().includes(search.toLowerCase()) ||
            a.ticker?.toLowerCase().includes(search.toLowerCase())
        )
      : allAssets;

    const total = filtered.length;
    const offset = (page - 1) * limit;
    const pageAssets = filtered.slice(offset, offset + limit);

    return plainToInstance(
      PaginatedWalletSummaryDto,
      {
        overview: plainToInstance(
          WalletOverviewDto,
          {
            wallet: walletAddress,
            totalValueAda: +allAssets.reduce((s, a) => s + a.valueAda, 0).toFixed(4),
            totalValueUsd: +allAssets.reduce((s, a) => s + a.valueUsd, 0).toFixed(4),
            totalValueEth: +allAssets.reduce((s, a) => s + a.valueEth, 0).toFixed(6),
            lastUpdated: new Date().toISOString(),
            summary: {
              totalAssets: allAssets.length,
              nfts: allAssets.filter(a => a.isNft).length,
              tokens: allAssets.filter(a => a.isFungibleToken).length,
              ada: 0,
            },
          },
          { excludeExtraneousValues: true }
        ),
        assets: pageAssets,
        pagination: plainToInstance(
          PaginationMetaDto,
          {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit) || 1,
            hasNextPage: offset + limit < total,
            hasPrevPage: page > 1,
          },
          { excludeExtraneousValues: true }
        ),
      },
      { excludeExtraneousValues: true }
    );
  }

  private async getWalletOverview(walletAddress: string, adaPriceUsd: number): Promise<WalletOverviewDto> {
    const overviewCacheKey = `wallet_overview_${walletAddress}`;
    const cached = this.cache.get<WalletOverviewDto>(overviewCacheKey);

    if (cached) {
      return cached;
    }

    try {
      // Validate address and check if it exists
      try {
        await this.blockfrost.addresses(walletAddress);
      } catch (error: any) {
        // If address has never received transactions, Blockfrost returns 404
        if (error.status_code === 404 || error.message?.includes('not been found')) {
          // Return empty wallet overview
          const emptyOverviewData = {
            wallet: walletAddress,
            totalValueAda: 0,
            totalValueUsd: 0,
            lastUpdated: new Date().toISOString(),
            summary: {
              totalAssets: 0,
              nfts: 0,
              tokens: 0,
              ada: 0,
            },
          };
          const emptyOverview = plainToInstance(WalletOverviewDto, emptyOverviewData, {
            excludeExtraneousValues: true,
          });
          this.cache.set(overviewCacheKey, emptyOverview, 300);
          return emptyOverview;
        }
        throw error; // Re-throw unexpected errors
      }

      // Get totals
      const addressTotal = await this.blockfrost.addressesTotal(walletAddress);

      const balances = this.calculateBalances(addressTotal);
      const totalAda = (balances.get('lovelace') || 0) / 1000000;
      const nonAdaAssets = Array.from(balances.entries()).filter(
        ([unit, balance]) => unit !== 'lovelace' && balance > 0
      );

      const overviewData = {
        wallet: walletAddress,
        totalValueAda: +totalAda.toFixed(4),
        totalValueUsd: +(totalAda * adaPriceUsd).toFixed(4),
        lastUpdated: new Date().toISOString(),
        summary: {
          totalAssets: nonAdaAssets.length,
          nfts: nonAdaAssets.filter(([, quantity]) => quantity === 1).length,
          tokens: nonAdaAssets.filter(([, quantity]) => quantity > 1).length,
          ada: totalAda,
        },
      };

      // Transform to DTO using plainToInstance
      const overview = plainToInstance(WalletOverviewDto, overviewData, {
        excludeExtraneousValues: true,
      });

      // Cache for 5 minutes
      this.cache.set(overviewCacheKey, overview, 300);
      return overview;
    } catch (err: any) {
      this.logger.error('Error creating wallet overview:', err.message);
      if (err.response?.status_code === 404) {
        throw new HttpException('Wallet address not found', 404);
      }
      throw new HttpException('Failed to fetch wallet overview', 500);
    }
  }

  private async getPaginatedAssets(
    walletAddress: string,
    page: number,
    limit: number,
    filter: 'all' | 'nfts' | 'tokens',
    whitelistedPolicies: string[],
    search?: string,
    customPriceMap?: Map<string, number>
  ): Promise<{ assets: AssetValueDto[]; pagination: PaginationMetaDto }> {
    try {
      const rawAssets = await this.getFilteredUnits(walletAddress, whitelistedPolicies);

      const offset = (page - 1) * limit;
      const targetCount = offset + limit;

      const matchedAssets: Array<{
        asset: { unit: string; quantity: number };
        detailsResult: { details: BlockfrostAssetResponseDto; cached?: boolean };
      }> = [];
      let checkedCount = 0;
      const CONCURRENCY_LIMIT = 5;

      outer: for (let i = 0; i < rawAssets.length && matchedAssets.length < targetCount; i += CONCURRENCY_LIMIT) {
        const batch = rawAssets.slice(i, i + CONCURRENCY_LIMIT);
        const batchResults = await Promise.all(batch.map(asset => this.fetchAssetDetailsFromApi(asset.unit)));

        for (let j = 0; j < batch.length; j++) {
          const asset = batch[j];
          const detailsResult = batchResults[j];

          if (!detailsResult) {
            this.logger.warn(
              `Skipping asset due to missing details from API. Wallet: ${walletAddress}, Asset unit: ${asset.unit}`
            );
            checkedCount++;
            continue;
          }

          const isMatch = this.checkAssetMatch(asset, detailsResult.details, filter, search);

          if (isMatch) {
            matchedAssets.push({ asset, detailsResult });
            if (matchedAssets.length >= targetCount) {
              checkedCount++;
              break outer;
            }
          }

          checkedCount++;
        }
      }

      const pageAssetsRaw = matchedAssets.slice(offset, targetCount);
      const pageAssets = await this.formatAndPriceAssets(pageAssetsRaw, customPriceMap);

      const hasNextPage = checkedCount < rawAssets.length && matchedAssets.length >= targetCount;

      const paginationData = {
        page,
        limit,
        total: hasNextPage ? null : matchedAssets.length,
        totalPages: hasNextPage ? null : page,
        hasNextPage,
        hasPrevPage: page > 1,
      };

      const pagination = plainToInstance(PaginationMetaDto, paginationData, {
        excludeExtraneousValues: true,
      });

      return { assets: pageAssets, pagination };
    } catch (err: any) {
      this.logger.error('Error getting paginated assets:', err.message);
      throw new HttpException('Failed to fetch paginated assets', 500);
    }
  }

  private async getFilteredUnits(
    walletAddress: string,
    whitelistedPolicies: string[]
  ): Promise<{ unit: string; quantity: number }[]> {
    const cacheKey = `wallet_assets_${walletAddress}`;
    const cached = this.walletUnitsCache.get<Array<{ unit: string; quantity: number }>>(cacheKey);

    let assetUnits: Array<{ unit: string; quantity: number }>;

    if (cached) {
      assetUnits = cached;
    } else {
      try {
        const addressTotal = await this.blockfrost.addressesTotal(walletAddress);
        const balances = this.calculateBalances(addressTotal);
        assetUnits = Array.from(balances.entries())
          .filter(([unit, balance]) => unit !== 'lovelace' && balance > 0)
          .map(([unit, quantity]) => ({ unit, quantity }));

        // Cache for 2 minutes
        this.walletUnitsCache.set(cacheKey, assetUnits, 60);
      } catch (err: any) {
        this.logger.error('Error fetching asset units:', err.message);
        throw new HttpException('Failed to fetch asset units', 500);
      }
    }

    return whitelistedPolicies.length
      ? assetUnits.filter(asset => whitelistedPolicies.includes(asset.unit.substring(0, 56)))
      : assetUnits;
  }

  private checkAssetMatch(
    asset: { unit: string; quantity: number },
    details: BlockfrostAssetResponseDto,
    filter: 'all' | 'nfts' | 'tokens',
    search?: string
  ): boolean {
    const isNFT = this.isNFT(details);

    if (filter === 'nfts' && !isNFT) return false;
    if (filter === 'tokens' && isNFT) return false;

    if (search && search.trim()) {
      const searchLower = search.toLowerCase().trim();
      const metadata = details.onchain_metadata || details.metadata || {};
      const assetName = this.decodeAssetName(details.asset_name || asset.unit.substring(56));
      const displayName = String((metadata as Record<string, unknown>)?.name || assetName).toLowerCase();
      const ticker = String(details.metadata?.ticker || '').toLowerCase();
      const policyId = details.policy_id.toLowerCase();

      const matchesSearch =
        assetName.toLowerCase().includes(searchLower) ||
        displayName.includes(searchLower) ||
        ticker.includes(searchLower) ||
        policyId.includes(searchLower) ||
        asset.unit.toLowerCase().includes(searchLower);

      if (!matchesSearch) return false;
    }

    return true;
  }

  private async formatAndPriceAssets(
    items: Array<{
      asset: { unit: string; quantity: number };
      detailsResult: { details: BlockfrostAssetResponseDto; cached?: boolean };
    }>,
    customPriceMap?: Map<string, number>
  ): Promise<AssetValueDto[]> {
    // Fetch ETH price for Cardano assets (needed for multi-currency support)
    const ethPriceUsd = await this.priceService.getEthPrice();

    const prepared = items.map(({ asset, detailsResult }) => {
      const details = detailsResult.details;
      const metadata = details.onchain_metadata || details.metadata || {};
      const assetName = this.decodeAssetName(details.asset_name || asset.unit.substring(56));
      const isNFT = this.isNFT(details);
      const readableName = String((metadata as Record<string, unknown>)?.name || assetName);
      return { asset, details, metadata, assetName, isNFT, readableName };
    });

    const prices = await Promise.all(
      prepared.map(({ asset, details, isNFT, readableName }) =>
        this.getAssetValue({
          policyId: details.policy_id || asset.unit.substring(0, 56),
          assetName: details.asset_name || asset.unit.substring(56),
          customPriceMap,
          isNFT,
          name: readableName,
        })
      )
    );

    return prepared.map(({ asset, details, metadata, assetName, isNFT }, idx) => {
      const { priceAda, priceUsd } = prices[idx];
      const priceEth = ethPriceUsd > 0 ? priceUsd / ethPriceUsd : 0;

      // Get decimals for proper value calculation
      // For FTs with decimals > 0, prices are per decimal-adjusted unit
      // For NFTs, decimals are always 0
      const decimals = details.metadata?.decimals || 0;
      const decimalAdjustedQuantity = decimals > 0 ? asset.quantity / Math.pow(10, decimals) : asset.quantity;

      // Extract raw image from metadata (check both 'image' and 'logo' fields)
      const rawImageCandidates = [
        (metadata as Record<string, unknown>)?.image,
        (metadata as Record<string, unknown>)?.logo,
        (details.metadata as any)?.image,
        (details.metadata as any)?.logo,
        (details.onchain_metadata as Record<string, unknown>)?.image,
        (details.onchain_metadata as Record<string, unknown>)?.logo,
      ];
      const rawImage =
        rawImageCandidates.find(
          (candidate): candidate is string | string[] => typeof candidate === 'string' || Array.isArray(candidate)
        ) || '';

      // Normalize image source (handles base64, IPFS, HTTP, chunked array, etc.)
      let normalizedImage = normalizeAssetImageSource(rawImage) || '';

      if (/^ipfs:\/\//i.test(normalizedImage)) {
        normalizedImage = normalizedImage.replace(/^ipfs:\/\//i, 'https://ipfs.blockfrost.dev/ipfs/');
      }

      const assetData: AssetValueDto = {
        tokenId: asset.unit,
        name: assetName,
        displayName: String((metadata as Record<string, unknown>)?.name || assetName),
        ticker: String(details.metadata?.ticker || ''),
        quantity: asset.quantity, // Keep raw quantity for frontend
        isNft: isNFT,
        isFungibleToken: !isNFT,
        priceAda,
        priceUsd,
        priceEth,
        valueAda: priceAda * decimalAdjustedQuantity, // Calculate value with decimal-adjusted quantity
        valueUsd: priceUsd * decimalAdjustedQuantity,
        valueEth: priceEth * decimalAdjustedQuantity,
        metadata: {
          image: normalizedImage,
          policyId: details.policy_id,
          decimals: details.metadata?.decimals || 0,
          description: String((metadata as Record<string, unknown>)?.description || ''),
          assetName: details.asset_name,
          fallback: false,
        },
      };
      return plainToInstance(AssetValueDto, assetData, { excludeExtraneousValues: true });
    });
  }

  /**
   * Determine if an asset is an NFT or Fungible Token
   * Uses multiple heuristics for accurate detection
   * @param assetDetails Asset details from Blockfrost
   * @returns true if NFT, false if FT
   */
  private isNFT(assetDetails: BlockfrostAssetResponseDto): boolean {
    // 1. Check for decimals > 0 (strongest FT indicator)
    // decimals: 0 is common for NFTs, only decimals > 0 indicates FT
    if (assetDetails.metadata?.decimals !== undefined && assetDetails.metadata.decimals > 0) {
      return false;
    }

    const qty = parseInt(assetDetails.quantity);

    // 2. Check CIP-25 standard flag combined with reasonable NFT supply
    // NFT collections can be limited editions (qty up to ~10,000)
    // FTs typically have supply in millions+
    const hasCip25Standard =
      assetDetails.onchain_metadata_standard === 'CIP25v1' || assetDetails.onchain_metadata_standard === 'CIP25v2';

    // 3. Check for NFT-specific metadata (CIP-25)
    const metadata = assetDetails.onchain_metadata;
    const hasNftMetadata = metadata && (metadata.attributes || metadata.mediaType || metadata.files);

    // If CIP-25 standard is explicitly set AND supply is reasonable for NFTs, it's an NFT
    if (hasCip25Standard && qty <= 100000) {
      return true;
    }

    // If has NFT metadata AND supply is reasonable, it's an NFT
    if (hasNftMetadata && qty <= 100000) {
      return true;
    }

    // 4. Check total quantity (if 1, likely NFT)
    if (qty === 1) {
      return true;
    }

    // 5. If quantity > 1 and no NFT indicators, it's a fungible token
    return false;
  }

  public invalidateWalletCache(walletAddress: string): void {
    if (!walletAddress) return;

    const assetsCacheKey = `wallet_assets_${walletAddress}`;

    const overviewCacheKey = `wallet_overview_${walletAddress}`;

    const deletedAssets = this.walletUnitsCache.del(assetsCacheKey);
    const deletedOverview = this.cache.del(overviewCacheKey);

    this.logger.log(
      `Cache invalidated for wallet ${walletAddress.slice(0, 6)}...${walletAddress.slice(-6)}. ` +
        `Assets deleted: ${deletedAssets > 0}, Overview deleted: ${deletedOverview > 0}`
    );
  }

  /**
   * Get LP pool data for a token
   * Proxies to TapToolsClient.getTokenPools (DexHunter pool list → VyFi for VyFi pools → Nexus for other DEXs, with Minswap API fallback when Nexus data is unavailable)
   * @param tokenUnit - Token unit (policyId + assetName in hex)
   * @returns Array of pool data with LP token units and total supply
   */
  public async getTokenPools(tokenUnit: string): Promise<TapToolsTokenPoolDto[]> {
    return this.tapToolsClient.getTokenPools(tokenUnit);
  }

  /**
   * Get token price in ADA for a full token unit.
   * Uses DexHunter service which prioritizes VyFi cache, then falls back to DexHunter/TapTools.
   */
  public async getTokenPriceAda(tokenUnit: string): Promise<TokenPriceResult> {
    if (!this.isMainnet) {
      return { tokenUnit, priceAda: null };
    }

    // Cardano token unit = 56-char policyId + optional assetName (hex)
    if (!tokenUnit || tokenUnit.length < 56) {
      this.logger.warn(`Invalid token unit received for price lookup: ${tokenUnit}`);
      return { tokenUnit, priceAda: null };
    }

    const policyId = tokenUnit.slice(0, 56);
    const assetName = tokenUnit.slice(56);

    try {
      const { priceAda } = await this.getAssetValue({
        policyId,
        assetName,
        isNFT: false,
      });

      return {
        tokenUnit,
        priceAda: priceAda > 0 ? priceAda : null,
      };
    } catch (error) {
      this.logger.warn(
        `Failed to resolve token price for ${tokenUnit.slice(0, 12)}...: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return { tokenUnit, priceAda: null };
    }
  }
}
