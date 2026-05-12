import { BlockFrostAPI } from '@blockfrost/blockfrost-js';

import { toHumanAmountString } from './stake-amounts';

import { TokenType } from '@/database/tokenStakingPosition.entity';

export type StakeAdminTokenBalances = {
  l4vaConfigured: boolean;
  l4vaRaw: string;
  l4vaHuman: string;
  vlrmConfigured: boolean;
  vlrmRaw: string;
  vlrmHuman: string;
  adaRaw: string;
  adaHuman: string;
};

export async function getStakeAdminWalletBalances(params: {
  blockfrost: BlockFrostAPI;
  adminAddress: string;
  tokenDecimalsFallback: number;
  getUnitForTokenType: (tokenType: TokenType) => string;
  getDecimalsForUnit: (unit: string) => number;
}): Promise<StakeAdminTokenBalances> {
  const { blockfrost, adminAddress, tokenDecimalsFallback, getUnitForTokenType, getDecimalsForUnit } = params;

  const l4vaUnit = getUnitForTokenType(TokenType.L4VA);
  const vlrmUnit = getUnitForTokenType(TokenType.VLRM);
  const l4vaConfigured = l4vaUnit.length > 0;
  const vlrmConfigured = vlrmUnit.length > 0;
  const l4vaDecimals = l4vaConfigured ? getDecimalsForUnit(l4vaUnit) : tokenDecimalsFallback;
  const vlrmDecimals = vlrmConfigured ? getDecimalsForUnit(vlrmUnit) : tokenDecimalsFallback;

  const addressInfo = await blockfrost.addresses(adminAddress);
  const amountByUnit = new Map<string, bigint>(
    (addressInfo.amount ?? []).map(entry => [entry.unit.toLowerCase(), BigInt(entry.quantity)])
  );

  const lovelaceRaw = amountByUnit.get('lovelace') ?? 0n;
  const l4vaRaw = l4vaUnit ? (amountByUnit.get(l4vaUnit.toLowerCase()) ?? 0n) : 0n;
  const vlrmRaw = vlrmUnit ? (amountByUnit.get(vlrmUnit.toLowerCase()) ?? 0n) : 0n;

  return {
    l4vaConfigured,
    l4vaRaw: l4vaRaw.toString(),
    l4vaHuman: toHumanAmountString(l4vaRaw, l4vaDecimals),
    vlrmConfigured,
    vlrmRaw: vlrmRaw.toString(),
    vlrmHuman: toHumanAmountString(vlrmRaw, vlrmDecimals),
    adaRaw: lovelaceRaw.toString(),
    adaHuman: toHumanAmountString(lovelaceRaw, 6),
  };
}
