import { Injectable, Logger } from '@nestjs/common';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';

/**
 * Input item for the policy grouping helper
 * Each item represents one asset with its pre-calculated multipliers
 */
interface PolicyGroupingItem {
  policyId: string;
  assetName: string | null; // null = policy-level, string = asset-level
  assetDbId?: string; // Database ID for tracking (optional)
  price: number; // Effective price used for grouping
  quantity: number;
  vtMultiplier: number;
  adaMultiplier?: number;
}

/**
 * Result of the policy grouping helper
 */
interface PolicyGroupingResult {
  /** Array of [policyId, assetName | null, vtMultiplier] tuples */
  policyMultipliers: [string, string | null, number][];
  /** Array of [policyId, assetName | null, adaMultiplier] tuples (optional) */
  adaMultipliers?: [string, string | null, number][];
  /** Map of assetDbId → { vtPerUnit, policyId, assetName } for tracking (optional) */
  multipliersByAssetId?: Map<string, { vtPerUnit: number; policyId: string; assetName: string | null }>;
}

interface MultiplierResult {
  multipliers: [string, string | null, number][];
  adaDistribution?: [string, string | null, number][];
  recalculatedClaimAmounts: Map<string, number>;
  recalculatedLovelaceAmounts?: Map<string, number>;
}

interface AcquirerTokenParams {
  /** Amount of ADA sent by the acquirer (in ADA, not lovelace) */
  adaSent: number;
  /** Total ADA acquired from all acquirers */
  totalAcquiredValueAda: number;
  /** Amount of VT tokens allocated to liquidity pool */
  lpVtAmount: number;
  /** Amount of ADA allocated to liquidity pool */
  lpAdaAmount: number;
  /** Total supply of vault tokens */
  vtSupply: number;
  /** Percentage of tokens offered to acquirers (0-1) */
  ASSETS_OFFERED_PERCENT: number;
  /** Price per VT token in ADA */
  vtPrice: number;
}

interface AcquirerTokenResult {
  /** Number of VT tokens to be received */
  vtReceived: number;
  /** Multiplier used for on-chain calculation */
  multiplier: number;
}

interface ContributorTokenParams {
  /** Value contributed in this specific transaction (in ADA) */
  txContributedValue: number;
  /** Total value contributed by this user across all transactions */
  userTotalValue: number;
  /** Total value locked (TVL) from all contributors */
  totalTvl: number;
  /** Amount of VT tokens allocated to liquidity pool */
  lpVtAmount: number;
  /** Total ADA acquired from all acquirers */
  totalAcquiredAda: number;
  /** Amount of ADA allocated to liquidity pool */
  lpAdaAmount: number;
  /** Total supply of vault tokens */
  vtSupply: number;
  /** Percentage of tokens offered to acquirers (0-1) */
  ASSETS_OFFERED_PERCENT: number;
}

interface ContributorTokenResult {
  /** Number of VT tokens to be received */
  vtAmount: number;
  /** Amount of ADA to be received (in lovelace) */
  lovelaceAmount: number;
  /** Proportion of this tx within user's total contribution (0-1) */
  proportionOfUserTotal: number;
  /** Total VT tokens the user will receive */
  userTotalVtTokens: number;
}

interface LiquidityPoolParams {
  /** Total ADA acquired from all acquirers */
  totalAcquiredAda: number;
  /** Total supply of vault tokens */
  vtSupply: number;
  /** Percentage of tokens offered to acquirers (0-1) */
  assetsOfferedPercent: number;
  /** Percentage of FDV to allocate to LP (0-1) */
  lpPercent: number;
  /** Total value of contributed assets (fallback FDV if no acquirers) */
  totalContributedValueAda: number;
}

interface LiquidityPoolResult {
  /** Amount of ADA for the liquidity pool */
  lpAdaAmount: number;
  /** Amount of VT tokens for the liquidity pool */
  lpVtAmount: number;
  /** Calculated price per VT token in ADA */
  vtPrice: number;
  /** Fully diluted valuation of the vault */
  fdv: number;
  /** Adjusted VT amount for on-chain LP (using multiplier) */
  adjustedVtLpAmount: number;
  /** Multiplier for on-chain ADA pair calculation */
  adaPairMultiplier: number;
  /** Raw LP multiplier ratio (before flooring) for decimal optimization */
  lpMultiplierRatio?: number;
}

interface AcquireMultiplierParams {
  /** Claims from contributors with their asset allocations */
  contributorsClaims: Claim[];
  /** Optional claims from acquirers (empty if 0% acquirer scenario) */
  acquirerClaims?: Claim[];
}

interface AcquireMultiplierResult {
  /** Array of [policyId, assetName | null, vtAmount] for each asset. Use null for policy-level multipliers. */
  acquireMultiplier: [string, string | null, number][];
  /** Array of [policyId, assetName | null, adaAmount] for each asset. Use null for policy-level multipliers. */
  adaDistribution: [string, string | null, number][];
  /** Map of claim ID to recalculated VT amount (qty × multiplier) for smart contract consistency */
  recalculatedClaimAmounts: Map<string, number>;
  /** Map of claim ID to recalculated lovelace amount (qty × ada_multiplier) for smart contract consistency */
  recalculatedLovelaceAmounts: Map<string, number>;
}

/**
 * DistributionCalculationService
 *
 * This service provides core business logic for calculating token and ADA distributions
 * for contributors and acquirers in the vault system. It includes formulas for
 * liquidity pool allocation, VT token pricing, contributor/acquirer shares, and
 * value retention metrics.
 *
 * Edge Cases Handled:
 * - Acquirers % = 0%: Contributors get all tokens, no acquire phase
 * - Acquirers % = 100%: Contributors get only ADA, no VT tokens
 * - LP % = 0%: No liquidity pool, price calculated from FDV/Supply
 * - Combined edge cases (e.g., 0% acquirers + 0% LP)
 */
@Injectable()
export class DistributionCalculationService {
  private readonly logger = new Logger(DistributionCalculationService.name);

  constructor() {}

  calculateAcquirerTokens(params: AcquirerTokenParams): AcquirerTokenResult {
    const { adaSent, vtSupply, ASSETS_OFFERED_PERCENT, totalAcquiredValueAda, lpVtAmount } = params;

    // ((ADA sent to the vault / total acquire ADA) * Assets Offered Percent) * (VT Supply - LP VT)
    const percentOfTotalAcquireAdaSent = this.round25(adaSent / totalAcquiredValueAda);
    const vtReceived = this.round25(percentOfTotalAcquireAdaSent * ASSETS_OFFERED_PERCENT * (vtSupply - lpVtAmount));
    const multiplier = Math.floor(vtReceived / adaSent / 1_000_000);
    const adjustedVtAmount = multiplier * adaSent * 1_000_000;
    return {
      vtReceived: adjustedVtAmount,
      multiplier,
    };
  }
  calculateContributorTokens(params: ContributorTokenParams): ContributorTokenResult {
    const {
      txContributedValue,
      userTotalValue,
      totalTvl,
      lpVtAmount,
      totalAcquiredAda,
      lpAdaAmount,
      vtSupply,
      ASSETS_OFFERED_PERCENT,
    } = params;

    // Calculate proportion of this transaction within user's total contribution
    const proportionOfUserTotal = userTotalValue > 0 ? txContributedValue / userTotalValue : 0;

    // Calculate contributor share of total value
    const contributorShare = totalTvl > 0 ? userTotalValue / totalTvl : 0;

    // Edge Case: If Acquirers = 100% (Contributors = 0%)
    // Contributors get NO VT, but receive ALL ADA (minus LP)
    let userTotalVtTokens: number;
    let vtAmount: number;

    if (ASSETS_OFFERED_PERCENT >= 1.0) {
      // All tokens go to acquirers, contributors get 0 VT
      userTotalVtTokens = 0;
      vtAmount = 0;

      this.logger.log(`Contributors get 0 VT (Acquirers = 100%). ` + `They will receive ADA only.`);
    } else {
      // Normal calculation: Contributors get VT based on their share
      userTotalVtTokens = this.round25((vtSupply - lpVtAmount) * (1 - ASSETS_OFFERED_PERCENT) * contributorShare);
      vtAmount = userTotalVtTokens * proportionOfUserTotal;
    }

    // Calculate ADA distribution
    // Contributors receive ADA from acquirers (minus LP allocation)
    const adaForContributors = totalAcquiredAda - lpAdaAmount;
    const userAdaShare = contributorShare * adaForContributors;
    const adaAmount = userAdaShare * proportionOfUserTotal;

    return {
      vtAmount: Math.floor(vtAmount),
      lovelaceAmount: Math.floor(adaAmount * 1_000_000), // Convert to lovelace
      proportionOfUserTotal,
      userTotalVtTokens: Math.round(userTotalVtTokens),
    };
  }

  /**
   * Calculate liquidity pool tokens and values
   *
   * Edge cases handled:
   * - Acquirers % = 0%: Use TVL as FDV, no acquire phase
   * - LP % = 0%: No liquidity pool, calculate token price from FDV/Supply
   * - Both can be 0% simultaneously
   */
  calculateLpTokens(params: LiquidityPoolParams): LiquidityPoolResult {
    const { totalAcquiredAda, assetsOfferedPercent, lpPercent, vtSupply, totalContributedValueAda } = params;

    let fdv: number;

    // Edge Case 1: No acquirers (Acquirers % = 0%)
    if (assetsOfferedPercent === 0) {
      // Use TVL of contributed assets as FDV
      fdv = totalContributedValueAda;

      this.logger.log(
        `No acquirers scenario: Using TVL (${totalContributedValueAda} ADA) as FDV. ` + `No acquire phase will occur.`
      );

      // If also no LP, return zero values with calculated token price
      if (lpPercent === 0 || fdv === 0) {
        const vtPrice = fdv > 0 ? this.round25(fdv / vtSupply) : 0;

        this.logger.log(`No LP scenario: VT price = ${vtPrice} ADA (FDV ${fdv} / Supply ${vtSupply})`);

        return {
          lpAdaAmount: 0,
          lpVtAmount: 0,
          vtPrice,
          fdv,
          adjustedVtLpAmount: 0,
          adaPairMultiplier: 0,
        };
      }

      // If LP exists with 0% acquirers, calculate LP from TVL
      // LP can only exist if ADA was contributed as an asset
    } else {
      // Normal FDV calculation: Total ADA from acquirers / % tokens offered
      fdv = this.round2(totalAcquiredAda / assetsOfferedPercent);
    }

    // Edge Case 2: No liquidity pool (LP % = 0%)
    if (lpPercent === 0) {
      const vtPrice = this.round25(fdv / vtSupply);

      this.logger.log(
        `No LP scenario: VT price calculated from FDV: ${vtPrice} ADA ` + `(FDV ${fdv} / Supply ${vtSupply})`
      );

      return {
        lpAdaAmount: 0,
        lpVtAmount: 0,
        vtPrice,
        fdv,
        adjustedVtLpAmount: 0,
        adaPairMultiplier: 0,
      };
    }

    // Normal LP calculation
    // LP % is a percentage of the FDV VALUE, split equally between ADA and VT
    const lpAdaAmount = Math.round(((lpPercent * fdv) / 2) * 1e6) / 1e6;
    const lpVtValue = this.round25((lpPercent * vtSupply) / 2);

    // Calculate token price: LP ADA / LP VT
    const vtPrice = lpVtValue > 0 ? this.round25(lpAdaAmount / lpVtValue) : 0;

    // Calculate multiplier for on-chain representation
    const lpMultiplierRatio = totalAcquiredAda > 0 ? lpVtValue / (totalAcquiredAda * 1_000_000) : 0;
    const adaPairMultiplier = Math.floor(lpMultiplierRatio);
    const adjustedVtLpAmount = adaPairMultiplier * totalAcquiredAda * 1_000_000;

    return {
      lpAdaAmount,
      lpVtAmount: lpVtValue,
      vtPrice,
      fdv,
      adjustedVtLpAmount,
      adaPairMultiplier,
      lpMultiplierRatio,
    };
  }

  calculateAcquireMultipliers(params: AcquireMultiplierParams): AcquireMultiplierResult {
    const { contributorsClaims, acquirerClaims } = params;

    const recalculatedClaimAmounts = new Map<string, number>();
    const recalculatedLovelaceAmounts = new Map<string, number>();

    // Build items for policy grouping
    const groupingItems: PolicyGroupingItem[] = [];

    // First pass: collect all assets, distribute VT PROPORTIONALLY to floor_price
    for (const claim of contributorsClaims) {
      const contributorLovelaceAmount = claim?.lovelace_amount || 0;
      const assets = claim.transaction.assets;

      // Calculate total transaction value from floor prices
      const totalTxValue = assets.reduce((sum, asset) => {
        const qty = Number(asset.quantity) || 1;
        const price = asset.floor_price ?? 0;
        return sum + qty * price;
      }, 0);

      // Track recalculated amounts for this claim
      let recalculatedVtAmount = 0;
      let recalculatedLovelace = 0;

      assets.forEach(asset => {
        const assetQuantity = Number(asset.quantity) || 1;
        const floorPrice = asset.floor_price ?? 0;
        const assetValue = assetQuantity * floorPrice;

        // Distribute VT PROPORTIONALLY to floor_price
        // Each asset gets: (assetValue / totalTxValue) * claim.amount
        const proportion = totalTxValue > 0 ? assetValue / totalTxValue : 1 / assets.length;
        const vtShare = Math.floor(proportion * claim.amount);
        const vtSharePerUnit = Math.floor(vtShare / assetQuantity);

        // Distribute ADA proportionally as well
        const adaShare = Math.floor(proportion * contributorLovelaceAmount);
        const adaSharePerUnit = Math.floor(adaShare / assetQuantity);

        // Add to grouping items
        groupingItems.push({
          policyId: asset.policy_id,
          assetName: asset.asset_id,
          price: floorPrice,
          quantity: assetQuantity,
          vtMultiplier: vtSharePerUnit,
          adaMultiplier: adaSharePerUnit,
        });

        // Recalculate VT amount using the same formula as smart contract: qty × multiplier
        recalculatedVtAmount += assetQuantity * vtSharePerUnit;
        recalculatedLovelace += assetQuantity * adaSharePerUnit;
      });

      // Store the recalculated amounts (these will match smart contract validation exactly)
      recalculatedClaimAmounts.set(claim.id, recalculatedVtAmount);
      recalculatedLovelaceAmounts.set(claim.id, recalculatedLovelace);
    }

    // Use centralized policy grouping logic
    const { policyMultipliers, adaMultipliers } = this.groupAssetsByPolicy(groupingItems, { includeAda: true });
    const acquireMultiplier = policyMultipliers;
    const adaDistribution = adaMultipliers || [];

    if (!acquirerClaims || acquirerClaims.length === 0) {
      return {
        acquireMultiplier,
        adaDistribution,
        recalculatedClaimAmounts,
        recalculatedLovelaceAmounts,
      };
    }

    const multiplier =
      acquirerClaims[0].multiplier ||
      Math.floor(acquirerClaims[0].amount / acquirerClaims[0].transaction.amount / 1_000_000);
    acquireMultiplier.push(['', '', multiplier]);

    return {
      acquireMultiplier,
      adaDistribution,
      recalculatedClaimAmounts,
      recalculatedLovelaceAmounts,
    };
  }

  /**
   * Calculate optimal decimals for vault tokens based on multipliers.
   *
   * Rules:
   * 1. Always use MIN_DECIMALS (6) as baseline - Cardano standard
   * 2. Increase decimals if small multipliers would floor to 0 (underflow prevention)
   * 3. Increase decimals if LP multiplier has significant rounding loss (precision improvement)
   * 4. Cap at MAX_DECIMALS (8)
   * 5. Works for any supply from 1M to 1T - bigint storage handles large values
   *
   * Key insights:
   * - Underflow: If minMultiplier = 0.74 with 6 decimals, it floors to 0 (bad!)
   *   Increasing to 7 decimals: 0.74 * 10 = 7.4, floors to 7 (good!)
   * - LP precision: If lpMultiplier = 13.33 with 6 decimals, loss = 2.5%
   *   Increasing to 8 decimals: 1333.33, loss = 0.025% (100x better!)
   *
   * @param tokenSupply - The token supply (not used for overflow checks - bigint handles it)
   * @param minMultiplier - Optional minimum multiplier value (to prevent underflow to 0)
   * @param lpMultiplierRatio - Optional LP multiplier ratio (before flooring) for precision optimization
   * @returns Optimal number of decimals (6-8)
   */
  calculateOptimalDecimals(tokenSupply: number, minMultiplier?: number, lpMultiplierRatio?: number): number {
    const MAX_DECIMALS = 8;
    const MIN_DECIMALS = 6;
    const MIN_VALID_MULTIPLIER = 1;
    const LP_ROUNDING_LOSS_THRESHOLD = 0.01; // 1% loss threshold

    // Calculate extra decimals needed to prevent underflow (multiplier < 1 flooring to 0)
    let extraDecimalsForUnderflow = 0;
    if (minMultiplier !== undefined && minMultiplier > 0 && minMultiplier < MIN_VALID_MULTIPLIER) {
      // Need to increase decimals so that minMultiplier * 10^extraDecimals >= 1
      // extraDecimals >= -log10(minMultiplier)
      extraDecimalsForUnderflow = Math.ceil(-Math.log10(minMultiplier));

      this.logger.warn(
        `Multiplier underflow detected: minMultiplier=${minMultiplier.toFixed(4)}. ` +
          `Increasing decimals by ${extraDecimalsForUnderflow} to prevent 0 token distributions.`
      );
    }

    // Calculate extra decimals needed to reduce LP rounding loss
    let extraDecimalsForLpPrecision = 0;
    if (lpMultiplierRatio !== undefined && lpMultiplierRatio > 0) {
      const fractionalPart = lpMultiplierRatio - Math.floor(lpMultiplierRatio);
      const roundingLoss = fractionalPart / lpMultiplierRatio;

      // If rounding loss > 1%, increase decimals by 2 (gives 100x improvement)
      if (roundingLoss > LP_ROUNDING_LOSS_THRESHOLD) {
        extraDecimalsForLpPrecision = 2;
        this.logger.warn(
          `LP multiplier precision loss detected: ratio=${lpMultiplierRatio.toFixed(4)}, ` +
            `loss=${(roundingLoss * 100).toFixed(2)}%. Increasing decimals by 2 for better precision.`
        );
      }
    }

    // Final decimals: start at 6, add max of underflow or LP precision needs, cap at 8
    const extraDecimals = Math.max(extraDecimalsForUnderflow, extraDecimalsForLpPrecision);
    const finalDecimals = Math.min(MIN_DECIMALS + extraDecimals, MAX_DECIMALS);

    if (finalDecimals > MIN_DECIMALS) {
      this.logger.log(
        `Token supply ${tokenSupply}: decimals increased from ${MIN_DECIMALS} to ${finalDecimals} ` +
          `(underflow: ${extraDecimalsForUnderflow}, LP precision: ${extraDecimalsForLpPrecision}, ` +
          `minMultiplier: ${minMultiplier?.toFixed(4) || 'N/A'}, lpRatio: ${lpMultiplierRatio?.toFixed(4) || 'N/A'})`
      );
    }

    return finalDecimals;
  }

  /**
   * Calculate multipliers for contributor claims (during acquire phase)
   * Distributes VT and ADA proportionally based on floor prices
   * Supports both policy-level and asset-level multiplier grouping
   */
  calculateContributorMultipliers(params: {
    contributorsClaims: Claim[];
    includeAdaDistribution?: boolean;
  }): MultiplierResult {
    const { contributorsClaims, includeAdaDistribution = false } = params;

    const recalculatedClaimAmounts = new Map<string, number>();
    const recalculatedLovelaceAmounts = new Map<string, number>();

    // Build items for policy grouping
    const groupingItems: PolicyGroupingItem[] = [];

    // First pass: collect all assets, distribute VT PROPORTIONALLY to floor_price
    for (const claim of contributorsClaims) {
      const contributorLovelaceAmount = claim?.lovelace_amount || 0;
      const assets = claim.transaction.assets;

      // Calculate total transaction value from floor prices
      const totalTxValue = assets.reduce((sum, asset) => {
        const qty = Number(asset.quantity) || 1;
        const price = asset.floor_price ?? 0;
        return sum + qty * price;
      }, 0);

      // Track recalculated amounts for this claim
      let recalculatedVtAmount = 0;
      let recalculatedLovelace = 0;

      assets.forEach(asset => {
        const assetQuantity = Number(asset.quantity) || 1;
        const floorPrice = asset.floor_price ?? 0;
        const assetValue = assetQuantity * floorPrice;

        // Distribute VT PROPORTIONALLY to floor_price
        const proportion = totalTxValue > 0 ? assetValue / totalTxValue : 1 / assets.length;
        const vtShare = Math.floor(proportion * claim.amount);
        const vtSharePerUnit = Math.floor(vtShare / assetQuantity);

        // Distribute ADA proportionally as well (if needed)
        const adaShare = includeAdaDistribution ? Math.floor(proportion * contributorLovelaceAmount) : 0;
        const adaSharePerUnit = includeAdaDistribution ? Math.floor(adaShare / assetQuantity) : 0;

        // Add to grouping items
        groupingItems.push({
          policyId: asset.policy_id,
          assetName: asset.asset_id,
          price: floorPrice,
          quantity: assetQuantity,
          vtMultiplier: vtSharePerUnit,
          adaMultiplier: adaSharePerUnit,
        });

        // Recalculate amounts using smart contract formula: qty × multiplier
        recalculatedVtAmount += assetQuantity * vtSharePerUnit;
        if (includeAdaDistribution) {
          recalculatedLovelace += assetQuantity * adaSharePerUnit;
        }
      });

      // Store recalculated amounts
      recalculatedClaimAmounts.set(claim.id, recalculatedVtAmount);
      if (includeAdaDistribution) {
        recalculatedLovelaceAmounts.set(claim.id, recalculatedLovelace);
      }
    }

    // Use centralized policy grouping logic
    const { policyMultipliers, adaMultipliers } = this.groupAssetsByPolicy(groupingItems, {
      includeAda: includeAdaDistribution,
    });

    return {
      multipliers: policyMultipliers,
      adaDistribution: includeAdaDistribution ? adaMultipliers : undefined,
      recalculatedClaimAmounts,
      recalculatedLovelaceAmounts: includeAdaDistribution ? recalculatedLovelaceAmounts : undefined,
    };
  }

  /**
   * Calculate multipliers for expansion contributions
   * Uses asset prices and VT price to determine multipliers
   * Supports both policy-level and asset-level grouping
   * @param decimals - The vault's ft_token_decimals (default 6 for backward compatibility)
   * @param priceType - 'market' (divide floor price by VT price) or 'limit' (use vtPrice directly as VT amount)
   */
  calculateExpansionMultipliers(params: {
    assets: Asset[];
    vtPrice: number;
    decimals: number;
    priceType: 'market' | 'limit';
  }): MultiplierResult {
    const { assets, vtPrice, decimals = 6, priceType } = params;
    const decimalMultiplier = Math.pow(10, decimals);

    const recalculatedClaimAmounts = new Map<string, number>();

    // Build items for policy grouping
    const groupingItems: PolicyGroupingItem[] = [];

    for (const asset of assets) {
      const price = asset.floor_price || asset.dex_price || 0;
      if (price === 0) continue;

      // Calculate VT amount based on pricing type
      let vtPerAsset: number;
      if (priceType === 'limit') {
        // For limit pricing: vtPrice IS the VT amount per asset (not a divisor!)
        vtPerAsset = vtPrice * decimalMultiplier;
      } else {
        // For market pricing: Calculate VT from asset price / VT market price
        vtPerAsset = (price / vtPrice) * decimalMultiplier;
      }
      const vtMultiplier = Math.floor(vtPerAsset);

      groupingItems.push({
        policyId: asset.policy_id,
        assetName: asset.asset_id || null,
        price,
        quantity: asset.quantity || 1,
        vtMultiplier,
      });
    }

    this.logger.log(
      `Expansion multiplier calculation (${priceType} pricing): ` +
        `${groupingItems.length} assets, vtPrice=${vtPrice}, decimals=${decimals}, ` +
        `sample VT multiplier=${groupingItems[0]?.vtMultiplier || 0} base units`
    );

    // Use centralized policy grouping logic
    const { policyMultipliers } = this.groupAssetsByPolicy(groupingItems, { includeAda: false });

    return {
      multipliers: policyMultipliers,
      recalculatedClaimAmounts,
    };
  }

  /**
   * Helper method to apply recalculated amounts to claims
   * Updates claim.amount and claim.lovelace_amount based on multipliers
   */
  applyRecalculatedAmounts(
    claims: Claim[],
    recalculatedClaimAmounts: Map<string, number>,
    recalculatedLovelaceAmounts?: Map<string, number>
  ): void {
    for (const claim of claims) {
      const recalculatedVt = recalculatedClaimAmounts.get(claim.id);
      if (recalculatedVt !== undefined) {
        claim.amount = recalculatedVt;
      }

      if (recalculatedLovelaceAmounts) {
        const recalculatedAda = recalculatedLovelaceAmounts.get(claim.id);
        if (recalculatedAda !== undefined) {
          claim.lovelace_amount = recalculatedAda;
        }
      }
    }
  }

  /**
   * Calculate multipliers directly from assets (for 0% acquirers scenario)
   * Groups assets by policy when all assets have the same price
   * Returns multipliers and a map of asset ID to VT per unit
   *
   * @param assets - All contributed assets
   * @param totalContributedValueAda - Total value of all contributed assets (FDV)
   * @param vtSupply - Total vault token supply (with decimals applied)
   * @param customPriceMap - Optional map of policy_id -> custom price (overrides floor_price)
   */
  calculateMultipliersFromAssets(params: {
    assets: Asset[];
    totalContributedValueAda: number;
    vtSupply: number;
    customPriceMap?: Map<string, number>;
  }): {
    acquireMultiplier: [string, string | null, number][];
    adaDistribution: [string, string | null, number][];
    multipliersByAssetId: Map<string, { vtPerUnit: number; policyId: string; assetName: string | null }>;
  } {
    const { assets, totalContributedValueAda, vtSupply, customPriceMap } = params;

    // Helper to get effective price (custom > floor_price > dex_price)
    const getEffectivePrice = (asset: Asset): number => {
      if (customPriceMap?.has(asset.policy_id)) {
        return customPriceMap.get(asset.policy_id)!;
      }
      return asset.floor_price || asset.dex_price || 0;
    };

    // Build items for policy grouping
    const groupingItems: PolicyGroupingItem[] = [];

    for (const asset of assets) {
      const effectivePrice = getEffectivePrice(asset);
      const quantity = asset.quantity || 1;

      // Calculate VT for this asset: (assetValue / totalContributedValueAda) * vtSupply
      const assetValue = effectivePrice * quantity;
      const proportion = totalContributedValueAda > 0 ? assetValue / totalContributedValueAda : 0;
      const totalVt = Math.floor(proportion * vtSupply);
      const vtPerUnit = Math.floor(totalVt / quantity);

      groupingItems.push({
        policyId: asset.policy_id,
        assetName: asset.asset_id || null,
        assetDbId: asset.id, // Track by database ID
        price: effectivePrice,
        quantity,
        vtMultiplier: vtPerUnit,
        adaMultiplier: 0, // No ADA distribution for 0% acquirers
      });
    }

    // Use centralized policy grouping logic
    const { policyMultipliers, multipliersByAssetId } = this.groupAssetsByPolicy(groupingItems, {
      includeAda: false,
      trackByAssetId: true,
    });

    // Build ada distribution (all zeros for 0% acquirers)
    const adaDistribution: [string, string | null, number][] = policyMultipliers.map(([policyId, assetName]) => [
      policyId,
      assetName,
      0,
    ]);

    return {
      acquireMultiplier: policyMultipliers,
      adaDistribution,
      multipliersByAssetId: multipliersByAssetId || new Map(),
    };
  }

  /**
   * Single source of truth for policy grouping logic
   * Groups assets by policy when all assets in a policy have the same price,
   * otherwise creates asset-level multipliers
   *
   * @param items - Array of assets with pre-calculated multipliers
   * @param includeAda - Whether to include ADA multipliers in output (default: false)
   * @param trackByAssetId - Whether to track multipliers by asset DB ID (default: false)
   * @returns Grouped multipliers at policy or asset level
   */
  private groupAssetsByPolicy(
    items: PolicyGroupingItem[],
    options: { includeAda?: boolean; trackByAssetId?: boolean } = {}
  ): PolicyGroupingResult {
    const { includeAda = false, trackByAssetId = false } = options;

    const policyMultipliers: [string, string | null, number][] = [];
    const adaMultipliers: [string, string | null, number][] = [];
    const multipliersByAssetId = new Map<string, { vtPerUnit: number; policyId: string; assetName: string | null }>();

    // Step 1: Group items by (policyId, price)
    const itemsByPolicyAndPrice = new Map<string, PolicyGroupingItem[]>();
    for (const item of items) {
      const key = `${item.policyId}:${item.price}`;
      if (!itemsByPolicyAndPrice.has(key)) {
        itemsByPolicyAndPrice.set(key, []);
      }
      itemsByPolicyAndPrice.get(key)!.push(item);
    }

    // Step 2: Group by policy to determine if all assets have same price
    const policiesData = new Map<
      string,
      {
        priceGroups: Map<number, PolicyGroupingItem[]>;
        totalAssets: number;
      }
    >();

    for (const [, groupItems] of itemsByPolicyAndPrice.entries()) {
      const policyId = groupItems[0].policyId;
      const price = groupItems[0].price;

      if (!policiesData.has(policyId)) {
        policiesData.set(policyId, { priceGroups: new Map(), totalAssets: 0 });
      }

      const policyData = policiesData.get(policyId)!;
      if (!policyData.priceGroups.has(price)) {
        policyData.priceGroups.set(price, []);
      }
      policyData.priceGroups.get(price)!.push(...groupItems);
      policyData.totalAssets += groupItems.length;
    }

    // Step 3: Process each policy - single price = policy-level, multiple prices = asset-level
    for (const [policyId, policyData] of policiesData.entries()) {
      const { priceGroups, totalAssets } = policyData;
      const isSinglePrice = priceGroups.size === 1;

      if (isSinglePrice) {
        // Policy-level grouping: all assets have same price → one multiplier for the policy
        const [price, groupItems] = Array.from(priceGroups.entries())[0];

        // Calculate weighted average multiplier for the policy
        const totalQty = groupItems.reduce((sum, item) => sum + item.quantity, 0);
        const weightedVtSum = groupItems.reduce((sum, item) => sum + item.vtMultiplier * item.quantity, 0);
        const policyVtMultiplier = Math.floor(weightedVtSum / totalQty);

        // Use null for assetName to indicate policy-level multiplier
        policyMultipliers.push([policyId, null, policyVtMultiplier]);

        if (includeAda) {
          const weightedAdaSum = groupItems.reduce((sum, item) => sum + (item.adaMultiplier || 0) * item.quantity, 0);
          const policyAdaMultiplier = Math.floor(weightedAdaSum / totalQty);
          adaMultipliers.push([policyId, null, policyAdaMultiplier]);
        }

        this.logger.log(
          `Policy grouping: ${totalAssets} assets from ${policyId.slice(0, 8)}... ` +
            `(same price: ${price} ADA) → VT=${policyVtMultiplier}`
        );

        // Track by asset ID if requested
        if (trackByAssetId) {
          for (const item of groupItems) {
            if (item.assetDbId) {
              multipliersByAssetId.set(item.assetDbId, {
                vtPerUnit: policyVtMultiplier,
                policyId: item.policyId,
                assetName: null,
              });
            }
          }
        }
      } else {
        // Asset-level grouping: different prices → multiplier per asset
        for (const [, groupItems] of priceGroups.entries()) {
          for (const item of groupItems) {
            policyMultipliers.push([item.policyId, item.assetName, item.vtMultiplier]);

            if (includeAda) {
              adaMultipliers.push([item.policyId, item.assetName, item.adaMultiplier || 0]);
            }

            if (trackByAssetId && item.assetDbId) {
              multipliersByAssetId.set(item.assetDbId, {
                vtPerUnit: item.vtMultiplier,
                policyId: item.policyId,
                assetName: item.assetName,
              });
            }
          }
        }

        const priceList = [...priceGroups.keys()].slice(0, 5).join(', ');
        this.logger.log(
          `Asset-level entries: ${totalAssets} assets from ${policyId.slice(0, 8)}... ` +
            `(${priceGroups.size} different prices: ${priceList}${priceGroups.size > 5 ? '...' : ''} ADA)`
        );
      }
    }

    const result: PolicyGroupingResult = { policyMultipliers };
    if (includeAda) {
      result.adaMultipliers = adaMultipliers;
    }
    if (trackByAssetId) {
      result.multipliersByAssetId = multipliersByAssetId;
    }

    return result;
  }

  private round25(amount: number): number {
    return Math.round(amount * 1e25) / 1e25;
  }

  protected round2(amount: number): number {
    return Math.round(amount * 1e2) / 1e2;
  }
}
