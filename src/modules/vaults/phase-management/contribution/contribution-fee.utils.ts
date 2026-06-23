/**
 * Protocol fee is charged per contributed asset entry (each NFT or each FT type).
 * FT quantity is ignored — e.g. 500 L4VA_Fundable FT counts as 1 asset for fee.
 */
export function countAssetsForProtocolFee(assets: unknown[]): number {
  return assets.length;
}
