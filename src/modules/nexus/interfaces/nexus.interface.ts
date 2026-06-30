/**
 * Nexus API authentication response
 */
export interface NexusAuthResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number; // milliseconds
}

/**
 * Nexus API pool data structure
 * Complete response from GET /api/dex/pools/{poolId}
 */
export interface NexusPool {
  poolId: string;
  dex: string;
  tokenAPolicyId: string;
  tokenAAssetName: string;
  tokenAReserve: number;
  tokenBPolicyId: string;
  tokenBAssetName: string;
  tokenBReserve: number;
  lpPolicyId: string;
  lpAssetName: string;
  lpTotalSupply: number;
  price: number;
  tvlAda: number | null;
  feePercent: number;
  txHash: string;
  outputIndex: number;
  address: string;
  slot: number;
  blockNumber: number;
  blockTime: number;
  updatedAt: string;
  displayPrice: number | null;
}
