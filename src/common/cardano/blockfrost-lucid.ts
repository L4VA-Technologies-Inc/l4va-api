import type { Network } from '@lucid-evolution/core-types';
import { Blockfrost } from '@lucid-evolution/lucid';

/**
 * Blockfrost HTTPS root for Lucid’s provider (`/api/v0`).
 * Same pattern as Lucid + Blockfrost usage in VyFi and governance-refund services.
 */
export function blockfrostCardanoApiV0BaseUrl(network: Network): string {
  return `https://cardano-${network.toLowerCase()}.blockfrost.io/api/v0`;
}

export function createLucidBlockfrostProvider(projectId: string, network: Network): Blockfrost {
  return new Blockfrost(blockfrostCardanoApiV0BaseUrl(network), projectId);
}

/** `CARDANO_NETWORK === 'mainnet'` → Lucid `Mainnet`, otherwise `Preprod`. */
export function lucidNetworkFromCardanoEnv(isMainnet: boolean): 'Mainnet' | 'Preprod' {
  return isMainnet ? 'Mainnet' : 'Preprod';
}
