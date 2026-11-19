import { describe, expect, it } from '@jest/globals';
import { toEventSelector, toFunctionSelector, type AbiEvent, type AbiFunction } from 'viem';

import { computeEvmAllocationRows, computeEvmLpCarveout } from './evm-allocation.formulas';
import {
  buildV13Economics,
  computeV13RaisePools,
  EvmLpMode,
  v13AcquirerVt,
  v13FromSaleRate,
  v13RootOpen,
  VAULT_V13_ABI,
  type EvmVaultEconomics,
} from './evm-v13';
import { VAULT_CONFIG_ABI_V13 } from './evm-vault-signer.service';

const E18 = 10n ** 18n;
const fn = (name: string): AbiFunction =>
  VAULT_V13_ABI.find(e => e.type === 'function' && e.name === name) as AbiFunction;
const ev = (name: string): AbiEvent => VAULT_V13_ABI.find(e => e.type === 'event' && e.name === name) as AbiEvent;

describe('V13 ABI matches the compiled contracts (forge inspect methodIdentifiers / events)', () => {
  it.each([
    ['openCycle', '0x09ab983e'],
    ['getDistribution', '0x3b345a87'],
    ['claimOnchainAllocation', '0xcf3ac847'],
    ['onchainEntitlement', '0x65a4a7e1'],
    ['cycleV13', '0x706fa141'],
    ['economics', '0x2e239d97'],
    ['swapForLp', '0xfb6f20fb'],
    ['recommitAllocationRoot', '0xd08c1f2a'],
    ['lpSliceTokens', '0xad4fc4d6'],
    ['lpSlice', '0x8723812a'],
  ])('%s', (name, selector) => {
    expect(toFunctionSelector(fn(name))).toBe(selector);
  });

  // Selectors only cover inputs; a struct whose fields moved still decodes into the wrong slots.
  it.each([
    [
      'getDistribution',
      '((address,uint48,uint256,uint256,uint256,uint256,uint64,uint64,uint64,bool,bool,address,bool))',
    ],
    ['cycleV13', '(uint256,uint256,uint256,uint256,uint256,uint64,bool,bool)'],
    ['economics', '((uint256,uint16,uint16,uint8,uint256,uint16))'],
    ['onchainEntitlement', '(uint256,bool)'],
    ['lpSlice', '(uint256,uint256)'],
    ['lpSliceTokens', '(address[])'],
  ])('%s outputs', (name, types) => {
    const t = (p: { type: string; components?: readonly unknown[] }): string =>
      p.type.startsWith('tuple')
        ? `(${(p.components as { type: string }[]).map(t).join(',')})${p.type.slice(5)}`
        : p.type;
    expect(`(${fn(name).outputs.map(t).join(',')})`).toBe(types);
  });

  it('has no Merkle distribution entries and one openCycle', () => {
    const names = VAULT_V13_ABI.filter(e => e.type === 'function').map(e => (e as AbiFunction).name);
    expect(names).not.toContain('openDistributionMerkle');
    expect(names).not.toContain('claimDistributionWithProofFor');
    expect(names.filter(n => n === 'openCycle')).toHaveLength(1);
  });

  it('factory createVault takes the V13 VaultConfig', () => {
    const createVault = {
      type: 'function',
      name: 'createVault',
      stateMutability: 'nonpayable',
      inputs: [VAULT_CONFIG_ABI_V13[0], { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }],
      outputs: [],
    } as unknown as AbiFunction;
    expect(toFunctionSelector(createVault)).toBe('0x488fa53e');
  });

  it.each([
    ['OnchainAllocationClaimed', '0xca95f343a9fca7264c5d3af2b4dbc55f1bb2896ac011e1d526f5b1d157fb6393'],
    ['CyclePoolsSet', '0xf2779d3e2b1d00b1c13afbeb4f4d9cfd296eb756c9d97ccec71a51c32e05bc0e'],
    ['AllocationRootCancelled', '0x2e36e6fb8833358df24bae788802ee1a2b17b73925708dc43e12be53e0d0b9f5'],
    ['DistributionCancelled', '0x5c6070e104df6e9c30401b73ff9a0253d0fb92ff11bfbe9e3443c79c02f8c655'],
  ])('event %s', (name, topic) => {
    expect(toEventSelector(ev(name))).toBe(topic);
  });
});

describe('buildV13Economics', () => {
  const base = { ftTokenSupply: 1_000_000, vtDecimals: 18, maxExpansionBps: 2_500 };

  it('acquirer vault with LP → FromAcquire', () => {
    const e = buildV13Economics({ ...base, tokensForAcquiresPct: 60, lpPct: 10 });
    expect(e).toEqual({
      vtSupply: 1_000_000n * E18,
      acquirerBps: 6_000,
      lpBps: 1_000,
      lpMode: EvmLpMode.FromAcquire,
      lpVtPerNative: 0n,
      maxExpansionBps: 2_500,
    });
  });

  it('asset-only vault with LP → FromSale; no LP → None; creator price → FixedPrice', () => {
    expect(buildV13Economics({ ...base, tokensForAcquiresPct: 0, lpPct: 5 }).lpMode).toBe(EvmLpMode.FromSale);
    expect(buildV13Economics({ ...base, tokensForAcquiresPct: 50, lpPct: 0 }).lpMode).toBe(EvmLpMode.None);
    const fixed = buildV13Economics({ ...base, tokensForAcquiresPct: 50, lpPct: 5, lpVtPerNative: 300n * E18 });
    expect(fixed.lpMode).toBe(EvmLpMode.FixedPrice);
    expect(fixed.lpVtPerNative).toBe(300n * E18);
  });

  it('rejects out-of-range input', () => {
    expect(() => buildV13Economics({ ...base, tokensForAcquiresPct: 101, lpPct: 0 })).toThrow();
    expect(() => buildV13Economics({ ...base, tokensForAcquiresPct: 50, lpPct: 0, maxExpansionBps: 10_001 })).toThrow();
    expect(() => buildV13Economics({ ...base, ftTokenSupply: 0, tokensForAcquiresPct: 50, lpPct: 0 })).toThrow();
  });
});

describe('computeV13RaisePools (mirrors Vault._setPoolsAndCheck)', () => {
  const econ = (over: Partial<EvmVaultEconomics>): EvmVaultEconomics => ({
    vtSupply: 1_000_000n * E18,
    acquirerBps: 6_000,
    lpBps: 1_000,
    lpMode: EvmLpMode.FromAcquire,
    lpVtPerNative: 0n,
    maxExpansionBps: 2_500,
    ...over,
  });

  it('FromAcquire matches the pre-V13 backend carve-out', () => {
    const raised = 10n * E18;
    const fee = raised / 100n;
    const pools = computeV13RaisePools(econ({}), raised, fee);
    const legacy = computeEvmLpCarveout({
      vtSupplyBaseUnits: 1_000_000n * E18,
      totalNativeRaised: raised,
      assetsOfferedBps: 6_000,
      lpBps: 1_000,
      nativeFee: fee,
    })!;
    expect(pools.lpNative).toBe(legacy.lpNativeAmount);
    expect(pools.lpVt).toBe(legacy.lpVtAmount);
    expect(pools.lpRate).toBe(legacy.rate);
    const avail = 1_000_000n * E18 - pools.lpVt;
    expect(pools.acquirerPool).toBe((avail * 6_000n) / 10_000n);
    expect(pools.rootVtMax).toBe(avail - pools.acquirerPool);
    expect(pools.rootNativeMax).toBe(raised - fee - pools.lpNative);
  });

  it('FixedPrice: ETH budget = lp% of the net raise, no VT carved from supply', () => {
    const pools = computeV13RaisePools(
      econ({ acquirerBps: 0, lpBps: 2_000, lpMode: EvmLpMode.FixedPrice, lpVtPerNative: 300n * E18 }),
      10n * E18,
      0n
    );
    expect(pools.lpNative).toBe(2n * E18);
    expect(pools.lpRate).toBe(300n * E18);
    expect(pools.rootVtMax).toBe(1_000_000n * E18);
    expect(pools.rootNativeMax).toBe(8n * E18);
  });

  it('nothing raised: no acquirer pool, the acquirer share is not given to contributors', () => {
    const pools = computeV13RaisePools(econ({ lpMode: EvmLpMode.None, lpBps: 0 }), 0n, 0n);
    expect(pools.acquirerPool).toBe(0n);
    expect(pools.rootVtMax).toBe(400_000n * E18);
  });

  it('FromSale price: lp% of supply for the proceeds', () => {
    // 900,000 VT, 10 % slice sold for 0.2 ETH → 90,000 VT for 0.2 ETH.
    expect(v13FromSaleRate(900_000n * E18, 1_000, 2n * 10n ** 17n)).toBe(450_000n * E18);
  });
});

describe('V13 raise allocation: acquirers on-chain, root bounded', () => {
  const rows = [
    {
      contributor: '0x00000000000000000000000000000000000000a1' as const,
      nativeRaised: 6n * E18,
      contributedValue: 0n,
    },
    {
      contributor: '0x00000000000000000000000000000000000000a2' as const,
      nativeRaised: 4n * E18,
      contributedValue: 0n,
    },
    {
      contributor: '0x00000000000000000000000000000000000000c1' as const,
      nativeRaised: 0n,
      contributedValue: 5n * E18,
    },
    // Both roles: a leaf for the asset side, an on-chain row for the acquirer side.
    {
      contributor: '0x00000000000000000000000000000000000000b1' as const,
      nativeRaised: 0n,
      contributedValue: 3n * E18,
    },
  ];

  it('splits acquirer VT out of the leaves, exactly as claimOnchainAllocation pays it', () => {
    const e: EvmVaultEconomics = {
      vtSupply: 1_000_000n * E18,
      acquirerBps: 6_000,
      lpBps: 1_000,
      lpMode: EvmLpMode.FromAcquire,
      lpVtPerNative: 0n,
      maxExpansionBps: 2_500,
    };
    const raised = 10n * E18;
    const fee = raised / 100n;
    const pools = computeV13RaisePools(e, raised, fee);
    const r = computeEvmAllocationRows({
      rows,
      vtSupplyBaseUnits: e.vtSupply,
      assetsOfferedBps: e.acquirerBps,
      lpVtAmount: pools.lpVt,
      lpNativeAmount: pools.lpNative,
      contributionFeeBps: 100,
      acquirersOnchain: true,
    });

    expect(r.vtToAcquirers).toBe(pools.acquirerPool);
    expect(r.vtToContributors).toBe(pools.rootVtMax);
    expect(r.totalVtAllocation).toBeLessThanOrEqual(pools.rootVtMax);
    expect(r.totalNativeAllocation).toBeLessThanOrEqual(pools.rootNativeMax);
    // Leaves: asset contributors only.
    expect(r.perWallet.map(w => w.contributor)).toEqual([
      '0x00000000000000000000000000000000000000b1',
      '0x00000000000000000000000000000000000000c1',
    ]);
    // On-chain rows: what the contract pays each acquirer.
    expect(r.onchainRows).toEqual([
      { contributor: rows[0].contributor, vtAmount: v13AcquirerVt(pools.acquirerPool, 6n * E18, raised) },
      { contributor: rows[1].contributor, vtAmount: v13AcquirerVt(pools.acquirerPool, 4n * E18, raised) },
    ]);
  });

  it('without the flag, output is unchanged (pre-V13 vaults)', () => {
    const r = computeEvmAllocationRows({ rows, vtSupplyBaseUnits: 1_000n * E18, assetsOfferedBps: 5_000 });
    expect(r.onchainRows).toEqual([]);
    expect(r.perWallet).toHaveLength(4);
  });
});

describe('v13RootOpen', () => {
  const now = BigInt(Math.floor(Date.now() / 1000));
  it('opens after the delay or on approval, never after a cancel', () => {
    expect(v13RootOpen({ rootActivatesAt: now - 1n, rootCancelled: false, rootApproved: false })).toBe(true);
    expect(v13RootOpen({ rootActivatesAt: now + 3600n, rootCancelled: false, rootApproved: false })).toBe(false);
    expect(v13RootOpen({ rootActivatesAt: now + 3600n, rootCancelled: false, rootApproved: true })).toBe(true);
    expect(v13RootOpen({ rootActivatesAt: now - 1n, rootCancelled: true, rootApproved: true })).toBe(false);
  });
});
