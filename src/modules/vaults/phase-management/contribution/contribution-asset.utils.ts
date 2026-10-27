import { BadRequestException } from '@nestjs/common';

import { AssetType } from '@/types/asset.types';

export const MAX_ASSET_DECIMALS = 20;
export const DEFAULT_FT_DECIMALS = 6;

export interface ContributionAssetLike {
  type?: string;
  policyId?: string;
  quantity?: number | string;
  decimals?: number;
  metadata?: { decimals?: number };
}

/**
 * Resolve and validate FT decimals from a contribution request.
 * Rejects out-of-range values and mismatches between top-level and metadata fields.
 */
export function resolveFtDecimals(asset: ContributionAssetLike): number {
  const fromAsset = asset.decimals;
  const fromMetadata = asset.metadata?.decimals;

  if (fromAsset !== undefined && fromMetadata !== undefined && Number(fromAsset) !== Number(fromMetadata)) {
    throw new BadRequestException(
      `Inconsistent decimals for fungible token: decimals=${fromAsset}, metadata.decimals=${fromMetadata}`
    );
  }

  const raw = fromAsset ?? fromMetadata;
  if (raw === undefined || raw === null) {
    return DEFAULT_FT_DECIMALS;
  }

  const decimals = Number(raw);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_ASSET_DECIMALS) {
    throw new BadRequestException(
      `Invalid decimals value "${raw}". Must be an integer between 0 and ${MAX_ASSET_DECIMALS}.`
    );
  }

  return decimals;
}

/**
 * Parse an FT contribution's raw quantity as an unsigned bigint in base units.
 * Callers pass base-unit integers (e.g. wei, lovelace). Fractional or negative
 * inputs are rejected — an FT contribution API request must never contain a
 * decimal-adjusted amount.
 */
export function parseFtRawQuantity(asset: ContributionAssetLike): bigint {
  const raw = asset.quantity;
  if (raw === undefined || raw === null) {
    throw new BadRequestException('Fungible token contribution quantity is required');
  }

  let asBigInt: bigint;
  try {
    if (typeof raw === 'bigint') {
      asBigInt = raw;
    } else if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed === '' || !/^-?\d+$/.test(trimmed)) {
        throw new BadRequestException(
          `Fungible token contribution quantity must be an integer in base units, received "${raw}"`
        );
      }
      asBigInt = BigInt(trimmed);
    } else if (typeof raw === 'number') {
      if (!Number.isFinite(raw) || !Number.isInteger(raw)) {
        throw new BadRequestException(
          `Fungible token contribution quantity must be an integer in base units, received ${raw}`
        );
      }
      if (!Number.isSafeInteger(raw)) {
        throw new BadRequestException(
          `Fungible token contribution quantity ${raw} exceeds JS safe-integer range; send as a decimal string`
        );
      }
      asBigInt = BigInt(raw);
    } else {
      throw new BadRequestException(`Unsupported fungible token quantity type: ${typeof raw}`);
    }
  } catch (err) {
    if (err instanceof BadRequestException) throw err;
    throw new BadRequestException(`Invalid fungible token quantity "${String(raw)}"`);
  }

  if (asBigInt <= 0n) {
    throw new BadRequestException('Fungible token contribution quantity must be greater than 0');
  }
  return asBigInt;
}

/**
 * Decimal-adjusted quantity used for vault capacity / policy limit checks.
 * NFTs always count as 1; FT quantity is normalized using validated decimals.
 *
 * Returns a `number` because the caller compares against integer caps
 * (max_contribute_assets, asset_count_cap_max) that are themselves ints in
 * a small range. Exact base-unit math is done with bigint first; the final
 * decimal-adjusted value only becomes a `number` after we have verified it
 * cannot exceed a reasonable count.
 */
export function getContributionQuantityForLimits(asset: ContributionAssetLike): number {
  if (asset.type === AssetType.NFT || asset.type === 'nft') {
    return 1;
  }

  if (asset.type === AssetType.FT || asset.type === 'ft') {
    const rawQuantity = parseFtRawQuantity(asset);
    const decimals = resolveFtDecimals(asset);
    return bigintDecimalAdjustedToNumber(rawQuantity, decimals);
  }

  return 1;
}

/**
 * Convert a raw base-unit bigint into a decimal-adjusted JS number safely.
 * Preserves fractional precision by splitting into integer and fractional
 * parts and only doing float division on the small fractional remainder.
 * Callers must accept that the result is *approximate* for extreme values
 * (> ~9e15 whole tokens); it is intended purely for count/limit comparisons.
 */
export function bigintDecimalAdjustedToNumber(rawQuantity: bigint, decimals: number): number {
  if (decimals <= 0) {
    // Whole units — must fit within safe integer range for a count comparison.
    if (rawQuantity > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new BadRequestException(
        `Fungible token quantity ${rawQuantity.toString(10)} exceeds safe integer range for capacity checks`
      );
    }
    return Number(rawQuantity);
  }
  const divisor = 10n ** BigInt(decimals);
  const whole = rawQuantity / divisor;
  const remainder = rawQuantity % divisor;
  if (whole > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new BadRequestException(
      `Fungible token whole-unit quantity ${whole.toString(10)} exceeds safe integer range for capacity checks`
    );
  }
  return Number(whole) + Number(remainder) / Number(divisor);
}

export function sumContributionQuantitiesForLimits(assets: ContributionAssetLike[]): number {
  return assets.reduce((total, asset) => total + getContributionQuantityForLimits(asset), 0);
}

/**
 * Normalize contribution assets:
 * - Persist validated decimals on FT assets for downstream limit checks
 * - Normalize EVM addresses (0x...) to lowercase for consistent comparison
 */
export function normalizeContributionAssets<T extends ContributionAssetLike>(assets: T[]): T[] {
  return assets.map(asset => {
    const normalized = { ...asset };

    // Normalize EVM addresses to lowercase
    if (asset.policyId && asset.policyId.startsWith('0x')) {
      normalized.policyId = asset.policyId.toLowerCase();
    }

    // Validate and persist decimals for fungible tokens
    if (asset.type === AssetType.FT || asset.type === 'ft') {
      normalized.decimals = resolveFtDecimals(asset);
    }

    return normalized;
  });
}
