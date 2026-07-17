import { defineChain } from 'viem';
import { createConfig, http } from 'wagmi';
import { injected } from 'wagmi/connectors';

// Robinhood Chain — Arbitrum L2 (EVM), mainnet launched 2026-07-01.
// Chain ID 4663 (mainnet) / 46630 (testnet). ETH is the native gas token.
// Active network is selected via VITE_ROBINHOOD_NETWORK ('mainnet' | 'testnet'),
// mirroring the Cardano VITE_CARDANO_NETWORK convention.
const ROBINHOOD_NETWORK = import.meta.env.VITE_ROBINHOOD_NETWORK || 'mainnet';
const IS_TESTNET = ROBINHOOD_NETWORK === 'testnet';

export const robinhoodChain = defineChain({
  id: Number(import.meta.env.VITE_ROBINHOOD_CHAIN_ID) || (IS_TESTNET ? 46630 : 4663),
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [import.meta.env.VITE_ROBINHOOD_RPC_URL] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: import.meta.env.VITE_ROBINHOOD_BLOCKSCOUT_URL },
  },
});

// Single optional RPC override; if empty, the active chain's public default is used.
const RPC_URL = import.meta.env.VITE_ROBINHOOD_RPC_URL || robinhoodChain.rpcUrls.default.http[0];

// `injected()` auto-discovers browser-extension wallets via EIP-6963 (MetaMask,
// Rabby, Trust, etc.); coinbaseWallet + walletConnect broaden coverage to ~300 wallets.
const connectors = [injected()];

export const wagmiConfig = createConfig({
  chains: [robinhoodChain],
  connectors,
  transports: {
    [robinhoodChain.id]: http(RPC_URL),
  },
});
