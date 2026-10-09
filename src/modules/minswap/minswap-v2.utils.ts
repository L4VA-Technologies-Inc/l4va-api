import { createHash } from 'crypto';

import { Constr, Data, getAddressDetails } from '@lucid-evolution/lucid';

/**
 * Pure Minswap V2 helpers ported from the official SDK (@minswap/sdk, @spacebudz/lucid)
 * to @lucid-evolution. Kept dependency-free so they can be unit-tested.
 */

export type MinswapAsset = { policyId: string; tokenName: string };

export const ADA_ASSET: MinswapAsset = { policyId: '', tokenName: '' };

export function assetFromUnit(unit: string): MinswapAsset {
  if (unit === 'lovelace') return ADA_ASSET;
  return { policyId: unit.slice(0, 56), tokenName: unit.slice(56) };
}

export function assetToUnit(asset: MinswapAsset): string {
  return asset.policyId === '' && asset.tokenName === '' ? 'lovelace' : asset.policyId + asset.tokenName;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a === b ? 0 : 1;
}

/** Asset ordering used by the factory/pool validators (ADA sorts first). */
export function compareAssets(a: MinswapAsset, b: MinswapAsset): number {
  return a.policyId === b.policyId ? compareStrings(a.tokenName, b.tokenName) : compareStrings(a.policyId, b.policyId);
}

function sha3(hex: string): string {
  return createHash('sha3-256').update(Buffer.from(hex, 'hex')).digest('hex');
}

/** LP token asset name = sha3(sha3(A) ++ sha3(B)) over the normalized (ADA-first, then lexicographic) pair. */
export function computeLpAssetName(assetA: MinswapAsset, assetB: MinswapAsset): string {
  const [first, second] = compareAssets(assetA, assetB) <= 0 ? [assetA, assetB] : [assetB, assetA];
  return sha3(sha3(first.policyId + first.tokenName) + sha3(second.policyId + second.tokenName));
}

/** ceil(sqrt(amountA * amountB)) */
export function calculateInitialLiquidity(amountA: bigint, amountB: bigint): bigint {
  const product = amountA * amountB;
  if (product < 0n) throw new Error('Negative liquidity product');
  if (product < 2n) return product;
  let x = product;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + product / x) / 2n;
  }
  return x * x < product ? x + 1n : x;
}

function assetToPlutusData(asset: MinswapAsset): Constr<Data> {
  return new Constr(0, [asset.policyId, asset.tokenName]);
}

/** Script hash of a stake (reward) address, e.g. the pool batching address. */
export function stakeScriptHash(rewardAddress: string): string {
  const credential = getAddressDetails(rewardAddress).stakeCredential;
  if (!credential || credential.type !== 'Script') {
    throw new Error(`Expected a script stake credential in ${rewardAddress}`);
  }
  return credential.hash;
}

export function encodePoolDatum(params: {
  poolBatchingStakeScriptHash: string;
  assetA: MinswapAsset;
  assetB: MinswapAsset;
  totalLiquidity: bigint;
  reserveA: bigint;
  reserveB: bigint;
  tradingFeeNumerator: bigint;
  /** Protocol fee sharing; new pools are created without it (same as the SDK). */
  feeSharingNumerator?: bigint;
}): string {
  return Data.to(
    new Constr(0, [
      // StakingHash(Credential::Script(hash))
      new Constr(0, [new Constr(1, [params.poolBatchingStakeScriptHash])]),
      assetToPlutusData(params.assetA),
      assetToPlutusData(params.assetB),
      params.totalLiquidity,
      params.reserveA,
      params.reserveB,
      params.tradingFeeNumerator,
      params.tradingFeeNumerator,
      params.feeSharingNumerator !== undefined ? new Constr(0, [params.feeSharingNumerator]) : new Constr(1, []),
      // allow dynamic fee: False
      new Constr(0, []),
    ])
  );
}

export function encodeFactoryDatum(head: string, tail: string): string {
  return Data.to(new Constr(0, [head, tail]));
}

export function decodeFactoryDatum(datumCbor: string): { head: string; tail: string } {
  const data = Data.from(datumCbor) as Constr<Data>;
  if (!(data instanceof Constr) || data.index !== 0 || data.fields.length !== 2) {
    throw new Error('Invalid Minswap V2 factory datum');
  }
  return { head: data.fields[0] as string, tail: data.fields[1] as string };
}

export function encodeFactoryRedeemer(assetA: MinswapAsset, assetB: MinswapAsset): string {
  return Data.to(new Constr(0, [assetToPlutusData(assetA), assetToPlutusData(assetB)]));
}

/** Authen minting policy redeemer for pool creation (CreatePool = Constr 1). */
export const AUTHEN_MINT_CREATE_POOL_REDEEMER = Data.to(new Constr(1, []));
