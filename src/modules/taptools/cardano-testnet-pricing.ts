/** Default ADA price for testnet assets without a configured override */
export const DEFAULT_TESTNET_ASSET_PRICE_ADA = 5.0;

/**
 * Hardcoded testnet prices keyed by policy ID or full token unit (policyId + assetName hex).
 * Used when external pricing APIs (WayUp, DexHunter) are unavailable on preprod.
 */
export const CARDANO_TESTNET_ASSET_PRICES_ADA: Record<string, number> = {
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

/**
 * Resolve a testnet ADA price for a Cardano asset.
 * Priority: asset-specific unit → policy-level → default fallback.
 */
export function resolveCardanoTestnetPriceAda(policyId: string, assetId: string): number {
  const unit = `${policyId}${assetId}`;
  if (CARDANO_TESTNET_ASSET_PRICES_ADA[unit] !== undefined) {
    return CARDANO_TESTNET_ASSET_PRICES_ADA[unit];
  }
  if (CARDANO_TESTNET_ASSET_PRICES_ADA[policyId] !== undefined) {
    return CARDANO_TESTNET_ASSET_PRICES_ADA[policyId];
  }
  return DEFAULT_TESTNET_ASSET_PRICE_ADA;
}

/**
 * Read a positive stored price from DB fields (treats 0 as unset).
 */
export function readPositiveStoredPriceAda(
  type: string,
  floorPrice?: number | null,
  dexPrice?: number | null
): number | null {
  const candidates =
    type === 'nft'
      ? [floorPrice, dexPrice]
      : [dexPrice, floorPrice];

  for (const price of candidates) {
    if (price != null && price > 0) {
      return Number(price);
    }
  }

  return null;
}
