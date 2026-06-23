/**
 * Estimates ADA wallet cost for a contribution transaction.
 * Protocol fee scales per asset; Cardano overhead (min ADA + network fee) is
 * mostly flat when assets are bundled in one output.
 */

const CARDANO_OVERHEAD_BASE = 3.65;
const CARDANO_OVERHEAD_PER_EXTRA_ASSET = 0.05;

/**
 * @param {{ assetCount: number, protocolFeePerAssetAda?: number }} params
 */
export function estimateContributionTransactionCost({ assetCount, protocolFeePerAssetAda = 0 }) {
  const count = Math.max(0, Number.isFinite(assetCount) ? assetCount : 0);
  const feePerAsset = Number.isFinite(protocolFeePerAssetAda) ? protocolFeePerAssetAda : 0;

  const protocolFeeAda = count * feePerAsset;
  const cardanoOverheadAda =
    count > 0 ? CARDANO_OVERHEAD_BASE + Math.max(0, count - 1) * CARDANO_OVERHEAD_PER_EXTRA_ASSET : 0;
  const totalWalletAda = protocolFeeAda + cardanoOverheadAda;

  return {
    assetCount: count,
    protocolFeePerAssetAda: feePerAsset,
    protocolFeeAda,
    cardanoOverheadAda,
    totalWalletAda,
  };
}
