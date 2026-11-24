/**
 * Protocol burn wallets. Assets sent here are treated as destroyed: NFTs from
 * terminated vaults and the burn share of the L4VA buyback.
 */
export const BURN_WALLET_TESTNET =
  'addr_test1qzdv6pn0ltar7q3hhgrgts2yqvphxtptr4m3t4xf5lfyx7hc3v9amrnu0cp6zt3vkry03838n2mv9e69g8e70aqktgcsnvkule';
export const BURN_WALLET_MAINNET =
  'addr1qxnk9w6e3azattu87ythnnjt2vmtlskzcld0ptwa924j0znz7v4zyqfqapmueh24l2r8v848mya68nndvjy783m656kq0cxjsn';

export const getBurnWallet = (isMainnet: boolean): string => (isMainnet ? BURN_WALLET_MAINNET : BURN_WALLET_TESTNET);
