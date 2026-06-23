import { BadRequestException } from '@nestjs/common';

import { AssetType } from '@/types/asset.types';

export const MAX_ASSET_DECIMALS = 20;
export const DEFAULT_FT_DECIMALS = 6;

export interface ContributionAssetLike {
  type?: string;
  quantity?: number;
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
 * Decimal-adjusted quantity used for vault capacity / policy limit checks.
 * NFTs always count as 1; FT quantity is normalized using validated decimals.
 */
export function getContributionQuantityForLimits(asset: ContributionAssetLike): number {
  if (asset.type === AssetType.NFT || asset.type === 'nft') {
    return 1;
  }

  if (asset.type === AssetType.FT || asset.type === 'ft') {
    const rawQuantity = Number(asset.quantity);
    if (!Number.isFinite(rawQuantity) || rawQuantity <= 0) {
      throw new BadRequestException('Fungible token contribution quantity must be greater than 0');
    }

    const decimals = resolveFtDecimals(asset);
    return decimals > 0 ? rawQuantity / Math.pow(10, decimals) : rawQuantity;
  }

  return 1;
}

export function sumContributionQuantitiesForLimits(assets: ContributionAssetLike[]): number {
  return assets.reduce((total, asset) => total + getContributionQuantityForLimits(asset), 0);
}

/** Persist validated decimals on FT assets so downstream limit checks use trusted values. */
export function normalizeContributionAssets<T extends ContributionAssetLike>(assets: T[]): T[] {
  return assets.map(asset => {
    if (asset.type === AssetType.FT || asset.type === 'ft') {
      return { ...asset, decimals: resolveFtDecimals(asset) };
    }
    return asset;
  });
}
