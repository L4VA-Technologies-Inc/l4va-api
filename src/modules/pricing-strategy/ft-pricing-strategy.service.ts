import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Charli3Client } from '@/modules/charli3/charli3.client';
import { DexHunterPricingClient } from '@/modules/dexhunter/dexhunter-pricing.client';
import { DexHunterPricingService } from '@/modules/dexhunter/dexhunter-pricing.service';
import { NexusClient } from '@/modules/nexus/nexus.client';
import { TapToolsClient } from '@/modules/taptools/taptools.client';

/**
 * Supported pricing API sources for fungible tokens
 */
export enum FTPricingSource {
  /** VyFi API - Fast bulk pricing via Redis cache (default) */
  VYFI = 'vyfi',
  /** DexHunter API - Direct API calls */
  DEXHUNTER = 'dexhunter',
  /** Charli3 API - Aggregate pricing across all DEXes */
  CHARLI3 = 'charli3',
  /** Nexus API - Pool-based pricing */
  NEXUS = 'nexus',
  /** Auto mode - Try all sources in order: VyFi → DexHunter → Charli3 → Nexus */
  AUTO = 'auto',
}

/**
 * Policy-specific pricing rule
 */
export interface PolicyPricingRule {
  /** Policy ID to match */
  policyId: string;
  /** Preferred pricing source for this policy */
  source: FTPricingSource;
  /** Optional: specific pool ID for Nexus pricing */
  poolId?: string;
  /** Optional: description/reason for this rule */
  description?: string;
}

/**
 * FT Pricing Strategy Service
 *
 * Flexible token pricing router that supports:
 * - Global default pricing source (configurable)
 * - Policy-specific overrides (e.g., certain tokens always use VyFi)
 * - Automatic fallback to alternative sources
 *
 * Configuration:
 * - FT_PRICING_DEFAULT_SOURCE: 'vyfi' | 'dexhunter' | 'charli3' | 'nexus' | 'auto' (default: 'auto')
 * - Policy rules: stored in database (future) or in-memory config (for now)
 *
 * Usage:
 * ```ts
 * const price = await ftPricingStrategy.getTokenPrice(tokenUnit);
 * const prices = await ftPricingStrategy.getTokenPrices([tokenUnit1, tokenUnit2]);
 * ```
 */
@Injectable()
export class FTPricingStrategyService {
  private readonly logger = new Logger(FTPricingStrategyService.name);
  private readonly defaultSource: FTPricingSource;
  private readonly policyRules = new Map<string, PolicyPricingRule>();

  constructor(
    private readonly configService: ConfigService,
    private readonly dexHunterPricingService: DexHunterPricingService,
    private readonly dexHunterPricingClient: DexHunterPricingClient,
    private readonly charli3Client: Charli3Client,
    private readonly tapToolsClient: TapToolsClient,
    private readonly nexusClient: NexusClient
  ) {
    // Load default source from config
    const configuredSource =
      this.configService.get<string>('FT_PRICING_DEFAULT_SOURCE')?.toLowerCase() || 'auto';
    this.defaultSource = this.parseSource(configuredSource);

    this.logger.log(`FT pricing strategy initialized with default source: ${this.defaultSource}`);

    // Initialize policy-specific rules (TODO: load from database)
    this.initializePolicyRules();
  }

  /**
   * Parse string to FTPricingSource enum
   */
  private parseSource(source: string): FTPricingSource {
    const normalized = source.toLowerCase();
    if (Object.values(FTPricingSource).includes(normalized as FTPricingSource)) {
      return normalized as FTPricingSource;
    }
    this.logger.warn(`Invalid FT pricing source: ${source}, falling back to AUTO`);
    return FTPricingSource.AUTO;
  }

  /**
   * Initialize policy-specific pricing rules
   * TODO: Load from database instead of hardcoded rules
   */
  private initializePolicyRules(): void {
    // Example: VyFi token should always use VyFi API
    // this.addPolicyRule({
    //   policyId: 'c48cbb3d5e9ad9b656f5e63aa0e92411c84e91837ea97144f88cf47e',
    //   source: FTPricingSource.VYFI,
    //   description: 'VyFi token - use VyFi API for native pricing',
    // });

    // Example: Specific token should use Charli3 for better aggregate pricing
    // this.addPolicyRule({
    //   policyId: '533bb94a8850ee3ccbe483106489399112b74c905342cb1792a797a0',
    //   source: FTPricingSource.CHARLI3,
    //   description: 'HOSKY - use Charli3 for aggregate DEX pricing',
    // });

    if (this.policyRules.size > 0) {
      this.logger.log(`Loaded ${this.policyRules.size} policy-specific pricing rules`);
    }
  }

  /**
   * Add a policy-specific pricing rule
   * @param rule Policy pricing rule
   */
  public addPolicyRule(rule: PolicyPricingRule): void {
    this.policyRules.set(rule.policyId, rule);
    this.logger.log(`Added pricing rule for policy ${rule.policyId}: ${rule.source}`);
  }

  /**
   * Remove a policy-specific pricing rule
   * @param policyId Policy ID to remove rule for
   */
  public removePolicyRule(policyId: string): void {
    if (this.policyRules.delete(policyId)) {
      this.logger.log(`Removed pricing rule for policy ${policyId}`);
    }
  }

  /**
   * Get all policy-specific pricing rules
   */
  public getPolicyRules(): PolicyPricingRule[] {
    return Array.from(this.policyRules.values());
  }

  /**
   * Get pricing source for a specific token
   * Checks policy rules first, then falls back to default source
   * @param tokenUnit Token unit (policyId + assetName in hex)
   * @returns Pricing source to use
   */
  private getPricingSourceForToken(tokenUnit: string): FTPricingSource {
    // Extract policy ID (first 56 characters of token unit)
    const policyId = tokenUnit.slice(0, 56);

    // Check for policy-specific rule
    const rule = this.policyRules.get(policyId);
    if (rule) {
      this.logger.debug(`Using policy rule for ${policyId.slice(0, 8)}...: ${rule.source}`);
      return rule.source;
    }

    // Use default source
    return this.defaultSource;
  }

  /**
   * Fetch price from VyFi (via Redis cache)
   */
  private async fetchFromVyFi(tokenUnit: string): Promise<number | null> {
    try {
      const price = await this.dexHunterPricingClient.getRedisPrice(tokenUnit);
      if (price !== null && price > 0) {
        this.logger.debug(`VyFi price for ${tokenUnit.slice(0, 10)}...: ${price} ADA`);
        return price;
      }
      return null;
    } catch (error) {
      this.logger.debug(`VyFi fetch failed for ${tokenUnit.slice(0, 10)}...`);
      return null;
    }
  }

  /**
   * Fetch price from DexHunter API
   */
  private async fetchFromDexHunter(tokenUnit: string): Promise<number | null> {
    try {
      const result = await this.dexHunterPricingClient.getTokenPrices([tokenUnit]);
      const price = result.get(tokenUnit);
      if (price !== null && price !== undefined && price > 0) {
        this.logger.debug(`DexHunter price for ${tokenUnit.slice(0, 10)}...: ${price} ADA`);
        return price;
      }
      return null;
    } catch (error) {
      this.logger.debug(`DexHunter fetch failed for ${tokenUnit.slice(0, 10)}...`);
      return null;
    }
  }

  /**
   * Fetch price from Charli3 API
   */
  private async fetchFromCharli3(tokenUnit: string): Promise<number | null> {
    try {
      const result = await this.tapToolsClient.getTokenPrices([tokenUnit]);
      const price = result.get(tokenUnit);
      if (price !== null && price !== undefined && price > 0) {
        this.logger.debug(`Charli3 price for ${tokenUnit.slice(0, 10)}...: ${price} ADA`);
        return price;
      }
      return null;
    } catch (error) {
      this.logger.debug(`Charli3 fetch failed for ${tokenUnit.slice(0, 10)}...`);
      return null;
    }
  }

  /**
   * Fetch price from Nexus API (via pool)
   * Note: Requires pool ID - not suitable for general token pricing without policy rules
   */
  private async fetchFromNexus(tokenUnit: string, poolId?: string): Promise<number | null> {
    try {
      if (!poolId) {
        this.logger.debug(`Nexus pricing requires poolId for token ${tokenUnit.slice(0, 10)}...`);
        return null;
      }

      // TODO: Implement Nexus pool-based pricing
      // const pool = await this.nexusClient.getPoolById(poolId);
      // Calculate price from pool reserves
      this.logger.debug(`Nexus pricing not yet implemented for ${tokenUnit.slice(0, 10)}...`);
      return null;
    } catch (error) {
      this.logger.debug(`Nexus fetch failed for ${tokenUnit.slice(0, 10)}...`);
      return null;
    }
  }

  /**
   * Fetch price using AUTO mode (try all sources in order)
   */
  private async fetchAuto(tokenUnit: string): Promise<number | null> {
    // Try VyFi first (fastest - Redis cache)
    let price = await this.fetchFromVyFi(tokenUnit);
    if (price !== null) return price;

    // Try DexHunter
    price = await this.fetchFromDexHunter(tokenUnit);
    if (price !== null) return price;

    // Try Charli3
    price = await this.fetchFromCharli3(tokenUnit);
    if (price !== null) return price;

    // Try Nexus last (requires pool ID, unlikely to work without policy rule)
    price = await this.fetchFromNexus(tokenUnit);
    if (price !== null) return price;

    return null;
  }

  /**
   * Get token price using configured strategy
   * @param tokenUnit Token unit (policyId + assetName in hex)
   * @returns Price in ADA, or null if not found
   */
  async getTokenPrice(tokenUnit: string): Promise<number | null> {
    const source = this.getPricingSourceForToken(tokenUnit);

    // Get policy rule for Nexus poolId if needed
    const policyId = tokenUnit.slice(0, 56);
    const rule = this.policyRules.get(policyId);
    const poolId = rule?.poolId;

    let price: number | null = null;

    switch (source) {
      case FTPricingSource.VYFI:
        price = await this.fetchFromVyFi(tokenUnit);
        break;

      case FTPricingSource.DEXHUNTER:
        price = await this.fetchFromDexHunter(tokenUnit);
        break;

      case FTPricingSource.CHARLI3:
        price = await this.fetchFromCharli3(tokenUnit);
        break;

      case FTPricingSource.NEXUS:
        price = await this.fetchFromNexus(tokenUnit, poolId);
        break;

      case FTPricingSource.AUTO:
      default:
        price = await this.fetchAuto(tokenUnit);
        break;
    }

    if (price === null) {
      this.logger.debug(`No price available for ${tokenUnit.slice(0, 10)}... from ${source} source`);
    }

    return price;
  }

  /**
   * Get prices for multiple tokens using configured strategy
   * @param tokenUnits Array of token units
   * @returns Map of tokenUnit -> price in ADA (null if not found)
   */
  async getTokenPrices(tokenUnits: string[]): Promise<Map<string, number | null>> {
    const results = new Map<string, number | null>();

    // Group tokens by pricing source for batch efficiency
    const sourceGroups = new Map<FTPricingSource, string[]>();

    for (const tokenUnit of tokenUnits) {
      const source = this.getPricingSourceForToken(tokenUnit);
      const group = sourceGroups.get(source) || [];
      group.push(tokenUnit);
      sourceGroups.set(source, group);
    }

    // Fetch prices per source group
    for (const [source, tokens] of sourceGroups) {
      if (source === FTPricingSource.AUTO) {
        // AUTO mode requires individual token processing
        for (const token of tokens) {
          const price = await this.fetchAuto(token);
          results.set(token, price);
        }
        continue;
      }

      // Batch fetch for specific sources
      try {
        let batchResults: Map<string, number | null> | null = null;

        switch (source) {
          case FTPricingSource.VYFI:
            batchResults = await this.dexHunterPricingClient.getRedisPrices(tokens);
            break;

          case FTPricingSource.DEXHUNTER:
            batchResults = await this.dexHunterPricingClient.getTokenPrices(tokens);
            break;

          case FTPricingSource.CHARLI3:
            batchResults = await this.tapToolsClient.getTokenPrices(tokens);
            break;

          case FTPricingSource.NEXUS:
            // Nexus doesn't support batch - process individually
            for (const token of tokens) {
              const policyId = token.slice(0, 56);
              const rule = this.policyRules.get(policyId);
              const price = await this.fetchFromNexus(token, rule?.poolId);
              results.set(token, price);
            }
            break;
        }

        if (batchResults) {
          batchResults.forEach((price, token) => {
            results.set(token, price);
          });
        }
      } catch (error) {
        this.logger.error(`Batch fetch failed for source ${source}`, error);
        // Set all tokens in this group to null
        tokens.forEach(token => results.set(token, null));
      }
    }

    return results;
  }

  /**
   * Get current default pricing source
   */
  public getDefaultSource(): FTPricingSource {
    return this.defaultSource;
  }

  /**
   * Update policy rule at runtime (for admin endpoints)
   * @param policyId Policy ID
   * @param source Pricing source
   * @param poolId Optional pool ID for Nexus
   * @param description Optional description
   */
  public updatePolicyRule(
    policyId: string,
    source: FTPricingSource,
    poolId?: string,
    description?: string
  ): void {
    this.addPolicyRule({ policyId, source, poolId, description });
  }

  /**
   * Get diagnostics info about current pricing strategy configuration
   */
  public getDiagnostics(): {
    defaultSource: FTPricingSource;
    policyRulesCount: number;
    policyRules: PolicyPricingRule[];
  } {
    return {
      defaultSource: this.defaultSource,
      policyRulesCount: this.policyRules.size,
      policyRules: this.getPolicyRules(),
    };
  }
}
