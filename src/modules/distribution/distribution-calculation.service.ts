import { Injectable, Logger } from '@nestjs/common';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';

interface AssetWithData {
  assetName: string | null;
  policyId: string;
  quantity: number;
  multiplier: number;
  adaMultiplier?: number;
  floorPrice: number;
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
    const adaPairMultiplier = totalAcquiredAda > 0 ? Math.floor(lpVtValue / (totalAcquiredAda * 1_000_000)) : 0;
    const adjustedVtLpAmount = adaPairMultiplier * totalAcquiredAda * 1_000_000;

    return {
      lpAdaAmount,
      lpVtAmount: lpVtValue,
      vtPrice,
      fdv,
      adjustedVtLpAmount,
      adaPairMultiplier,
    };
  }

  calculateAcquireMultipliers(params: AcquireMultiplierParams): AcquireMultiplierResult {
    const { contributorsClaims, acquirerClaims } = params;

    const acquireMultiplier: [string, string | null, number][] = [];
    const adaDistribution: [string, string | null, number][] = [];
    const recalculatedClaimAmounts = new Map<string, number>();
    const recalculatedLovelaceAmounts = new Map<string, number>();

    // Track assets grouped by (policy, floor_price)
    // Key: `${policyId}:${floorPrice}`, Value: array of assets with same price
    interface AssetWithData {
      assetName: string;
      quantity: number;
      multiplier: number;
      adaMultiplier: number;
      floorPrice: number;
    }

    const assetsByPolicyAndPrice = new Map<string, AssetWithData[]>();

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

        // Group by (policy, floor_price) for policy-level grouping decision
        const groupKey = `${asset.policy_id}:${floorPrice}`;
        if (!assetsByPolicyAndPrice.has(groupKey)) {
          assetsByPolicyAndPrice.set(groupKey, []);
        }
        assetsByPolicyAndPrice.get(groupKey)!.push({
          assetName: asset.asset_id,
          quantity: assetQuantity,
          multiplier: vtSharePerUnit,
          adaMultiplier: adaSharePerUnit,
          floorPrice,
        });

        // Recalculate VT amount using the same formula as smart contract: qty × multiplier
        recalculatedVtAmount += assetQuantity * vtSharePerUnit;
        recalculatedLovelace += assetQuantity * adaSharePerUnit;
      });

      // Store the recalculated amounts (these will match smart contract validation exactly)
      recalculatedClaimAmounts.set(claim.id, recalculatedVtAmount);
      recalculatedLovelaceAmounts.set(claim.id, recalculatedLovelace);
    }

    // Group assets by policy to decide grouping strategy
    const policiesData = new Map<
      string,
      {
        priceGroups: Map<number, AssetWithData[]>;
        totalAssets: number;
      }
    >();

    for (const [groupKey, assets] of assetsByPolicyAndPrice.entries()) {
      const [policyId, priceStr] = groupKey.split(':');
      const floorPrice = Number(priceStr);

      if (!policiesData.has(policyId)) {
        policiesData.set(policyId, { priceGroups: new Map(), totalAssets: 0 });
      }
      const policyData = policiesData.get(policyId)!;

      // Merge assets with same floor_price
      if (!policyData.priceGroups.has(floorPrice)) {
        policyData.priceGroups.set(floorPrice, []);
      }
      policyData.priceGroups.get(floorPrice)!.push(...assets);
      policyData.totalAssets += assets.length;
    }

    // Process each policy - single price = policy-level grouping
    for (const [policyId, policyData] of policiesData.entries()) {
      const { priceGroups, totalAssets } = policyData;
      const uniquePrices = priceGroups.size;

      // Case 1: All assets in policy have SAME floor_price → use policy-level multiplier
      if (uniquePrices === 1) {
        const [floorPrice, assets] = [...priceGroups.entries()][0];

        // Calculate weighted average multiplier for the policy
        const totalQty = assets.reduce((sum, a) => sum + a.quantity, 0);
        const weightedVtSum = assets.reduce((sum, a) => sum + a.multiplier * a.quantity, 0);
        const weightedAdaSum = assets.reduce((sum, a) => sum + a.adaMultiplier * a.quantity, 0);

        // Use floor to ensure we don't over-distribute
        const policyVtMultiplier = Math.floor(weightedVtSum / totalQty);
        const policyAdaMultiplier = Math.floor(weightedAdaSum / totalQty);

        acquireMultiplier.push([policyId, '', policyVtMultiplier]);
        adaDistribution.push([policyId, '', policyAdaMultiplier]);

        this.logger.log(
          `Policy grouping: ${totalAssets} assets from ${policyId.slice(0, 8)}... ` +
            `(same price: ${floorPrice} ADA) → VT=${policyVtMultiplier}, ADA=${policyAdaMultiplier}`
        );
      }
      // Case 2: Different floor_prices → asset-level entries
      else {
        for (const assets of priceGroups.values()) {
          for (const asset of assets) {
            acquireMultiplier.push([policyId, asset.assetName, asset.multiplier]);
            adaDistribution.push([policyId, asset.assetName, asset.adaMultiplier]);
          }
        }

        const priceList = [...priceGroups.keys()].slice(0, 5).join(', ');
        this.logger.log(
          `Asset-level entries: ${totalAssets} assets from ${policyId.slice(0, 8)}... ` +
            `(${uniquePrices} different prices: ${priceList}${uniquePrices > 5 ? '...' : ''} ADA)`
        );
      }
    }

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
   * 3. Cap at MAX_DECIMALS (8)
   * 4. Works for any supply from 1M to 1T - bigint storage handles large values
   *
   * Key insight for underflow prevention:
   * - If minMultiplier = 0.74 with 6 decimals, it floors to 0 (bad!)
   * - Increasing to 7 decimals: 0.74 * 10 = 7.4, floors to 7 (good!)
   * - Extra decimals needed = ceil(-log10(minMultiplier))
   *
   * @param tokenSupply - The token supply (not used for overflow checks - bigint handles it)
   * @param minMultiplier - Optional minimum multiplier value (to prevent underflow to 0)
   * @returns Optimal number of decimals (6-8)
   */
  calculateOptimalDecimals(tokenSupply: number, minMultiplier?: number): number {
    const MAX_DECIMALS = 8;
    const MIN_DECIMALS = 6;
    const MIN_VALID_MULTIPLIER = 1;

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

    // Final decimals: start at 6, add underflow prevention, cap at 8
    const finalDecimals = Math.min(MIN_DECIMALS + extraDecimalsForUnderflow, MAX_DECIMALS);

    if (finalDecimals > MIN_DECIMALS) {
      this.logger.log(
        `Token supply ${tokenSupply}: decimals increased from ${MIN_DECIMALS} to ${finalDecimals} for underflow prevention ` +
          `(minMultiplier: ${minMultiplier?.toFixed(4) || 'N/A'})`
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

    const multipliers: [string, string | null, number][] = [];
    const adaDistribution: [string, string | null, number][] = [];
    const recalculatedClaimAmounts = new Map<string, number>();
    const recalculatedLovelaceAmounts = new Map<string, number>();

    // Track assets grouped by (policy, floor_price)
    const assetsByPolicyAndPrice = new Map<string, AssetWithData[]>();

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

        // Group by (policy, floor_price)
        const groupKey = `${asset.policy_id}:${floorPrice}`;
        if (!assetsByPolicyAndPrice.has(groupKey)) {
          assetsByPolicyAndPrice.set(groupKey, []);
        }
        assetsByPolicyAndPrice.get(groupKey)!.push({
          assetName: asset.asset_id,
          policyId: asset.policy_id,
          quantity: assetQuantity,
          multiplier: vtSharePerUnit,
          adaMultiplier: adaSharePerUnit,
          floorPrice,
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

    // Group assets by policy to decide grouping strategy
    const policiesData = new Map<
      string,
      {
        priceGroups: Map<number, AssetWithData[]>;
        totalAssets: number;
      }
    >();

    for (const [groupKey, assets] of assetsByPolicyAndPrice.entries()) {
      const [policyId, priceStr] = groupKey.split(':');
      const floorPrice = Number(priceStr);

      if (!policiesData.has(policyId)) {
        policiesData.set(policyId, { priceGroups: new Map(), totalAssets: 0 });
      }
      const policyData = policiesData.get(policyId)!;

      if (!policyData.priceGroups.has(floorPrice)) {
        policyData.priceGroups.set(floorPrice, []);
      }
      policyData.priceGroups.get(floorPrice)!.push(...assets);
      policyData.totalAssets += assets.length;
    }

    // Process each policy - single price = policy-level grouping
    for (const [policyId, policyData] of policiesData.entries()) {
      const { priceGroups } = policyData;
      const uniquePrices = priceGroups.size;

      // Case 1: All assets have SAME floor_price → policy-level multiplier
      if (uniquePrices === 1) {
        const [floorPrice, assets] = [...priceGroups.entries()][0];
        const vtMultiplier = assets[0].multiplier;
        const adaMultiplier = assets[0].adaMultiplier || 0;

        multipliers.push([policyId, null, vtMultiplier]);
        if (includeAdaDistribution) {
          adaDistribution.push([policyId, null, adaMultiplier]);
        }

        this.logger.log(
          `Policy-level multiplier: ${policyId} → VT=${vtMultiplier}, ADA=${adaMultiplier} (${assets.length} assets, price=${floorPrice})`
        );
      } else {
        // Case 2: Multiple prices → asset-level multipliers
        for (const [floorPrice, assets] of priceGroups.entries()) {
          for (const asset of assets) {
            multipliers.push([asset.policyId, asset.assetName, asset.multiplier]);
            if (includeAdaDistribution) {
              adaDistribution.push([asset.policyId, asset.assetName, asset.adaMultiplier || 0]);
            }
          }

          this.logger.log(
            `Asset-level multipliers: ${policyId} (price=${floorPrice}) → ${assets.length} assets with VT=${assets[0].multiplier}, ADA=${assets[0].adaMultiplier || 0}`
          );
        }
      }
    }

    return {
      multipliers,
      adaDistribution: includeAdaDistribution ? adaDistribution : undefined,
      recalculatedClaimAmounts,
      recalculatedLovelaceAmounts: includeAdaDistribution ? recalculatedLovelaceAmounts : undefined,
    };
  }

  /**
   * Calculate multipliers for expansion contributions
   * Uses asset prices and VT price to determine multipliers
   * Supports both policy-level and asset-level grouping
   * @param decimals - The vault's ft_token_decimals (default 6 for backward compatibility)
   */
  calculateExpansionMultipliers(params: { assets: Asset[]; vtPrice: number; decimals: number }): MultiplierResult {
    const { assets, vtPrice, decimals = 6 } = params;
    const decimalMultiplier = Math.pow(10, decimals);

    const multipliers: [string, string | null, number][] = [];
    const recalculatedClaimAmounts = new Map<string, number>();
    const assetsByPolicyAndPrice = new Map<string, AssetWithData[]>();

    // Collect and group all assets by policy and price
    for (const fullAsset of assets) {
      const price = fullAsset.floor_price || fullAsset.dex_price || 0;
      if (price === 0) continue;

      // Calculate VT amount for this asset: (assetPrice / vtPrice) * 10^decimals
      // Example with decimals=1: 250 ADA / 1000 ADA per VT = 0.25 VT = 2.5 base units
      // Example with decimals=6: 250 ADA / 1000 ADA per VT = 0.25 VT = 250,000 base units
      const vtPerAsset = (price / vtPrice) * decimalMultiplier;
      const quantity = fullAsset.quantity || 1;
      const vtMultiplier = Math.floor(vtPerAsset);

      const groupKey = `${fullAsset.policy_id}:${price}`;

      if (!assetsByPolicyAndPrice.has(groupKey)) {
        assetsByPolicyAndPrice.set(groupKey, []);
      }

      assetsByPolicyAndPrice.get(groupKey)!.push({
        policyId: fullAsset.policy_id,
        assetName: fullAsset.asset_id || null,
        quantity,
        multiplier: vtMultiplier,
        floorPrice: price,
      });
    }

    // Group by policy to determine if we can use policy-level multipliers
    const policiesData = new Map<
      string,
      {
        priceGroups: Map<number, AssetWithData[]>;
        totalAssets: number;
      }
    >();

    for (const assets of assetsByPolicyAndPrice.values()) {
      const policyId = assets[0].policyId;
      const price = assets[0].floorPrice;

      if (!policiesData.has(policyId)) {
        policiesData.set(policyId, { priceGroups: new Map(), totalAssets: 0 });
      }

      const policyData = policiesData.get(policyId)!;
      policyData.priceGroups.set(price, assets);
      policyData.totalAssets += assets.length;
    }

    // Process each policy
    for (const [policyId, policyData] of policiesData.entries()) {
      // If all assets have same price, use policy-level multiplier
      if (policyData.priceGroups.size === 1) {
        const [price, assets] = Array.from(policyData.priceGroups.entries())[0];
        const multiplier = assets[0].multiplier;

        multipliers.push([policyId, null, multiplier]);

        this.logger.log(
          `Policy-level multiplier: ${policyId} → ${multiplier} (${assets.length} assets, price=${price})`
        );
      } else {
        // Different prices - need asset-level multipliers
        for (const [price, assets] of policyData.priceGroups.entries()) {
          const multiplier = assets[0].multiplier;

          for (const asset of assets) {
            multipliers.push([asset.policyId, asset.assetName, multiplier]);
          }

          this.logger.log(
            `Asset-level multipliers: ${policyId} (price=${price}) → ${multiplier} (${assets.length} assets)`
          );
        }
      }
    }

    return {
      multipliers,
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

  private round25(amount: number): number {
    return Math.round(amount * 1e25) / 1e25;
  }

  protected round2(amount: number): number {
    return Math.round(amount * 1e2) / 1e2;
  }
}
