import { describe, expect, it } from '@jest/globals';

import {
  basketAssetCapFor,
  currentEvmVersionRef,
  earliestEvmDeployBlock,
  LEGACY_MAX_TERMINATION_ASSETS,
  maxBasketAssetCapAnyVersion,
  terminationAssetCapFor,
  EVM_PROTOCOL_VERSIONS,
  findEvmProtocolVersionByFactory,
  findEvmProtocolVersionByFeeConverter,
  getEvmProtocolVersion,
  resolveVaultDeployBlock,
  resolveVaultLpAdapter,
  resolveVaultSwapAdapter,
} from './evm-protocol-versions';
import { isV13Version } from './evm-v13';

describe('evm protocol versions', () => {
  it('finds a version by factory, case-insensitively and per chain', () => {
    expect(findEvmProtocolVersionByFactory(4663, '0xf933f971dd670648162b393f02f718e49c788ebb')?.version).toBe(9);
    expect(findEvmProtocolVersionByFactory(4663, '0x7Eb5c9F3FE05C8e924BC4d1792D8C0Eb07fccC05')?.version).toBe(8);
    expect(findEvmProtocolVersionByFactory(4663, '0xceC9F4A79e3FF744aF845b6379561c570dc54CCf')?.version).toBe(10);
    expect(findEvmProtocolVersionByFactory(4663, '0xfB79Bf6a61950a04C64F1AD6Ef3b1809A21c2598')?.version).toBe(11);
    expect(findEvmProtocolVersionByFactory(4663, '0x2d100A23459df7AdEa1Cd369374B48Bda2cC1567')?.version).toBe(12);
    expect(findEvmProtocolVersionByFactory(46630, '0x6272107267D0d65031c0754cE7c61a10CC744771')?.version).toBe(10);
    expect(findEvmProtocolVersionByFactory(46630, '0x9795635535b11e09b561a67b87A175e516dfc680')?.version).toBe(11);
    expect(findEvmProtocolVersionByFactory(46630, '0xf933f971dd670648162b393f02f718e49c788ebb')).toBeNull();
  });

  it('returns null rather than guessing', () => {
    expect(findEvmProtocolVersionByFactory(4663, '0x0000000000000000000000000000000000000001')).toBeNull();
    expect(findEvmProtocolVersionByFactory(4663, null)).toBeNull();
    expect(findEvmProtocolVersionByFactory(1, '0xf933f971dd670648162b393f02f718e49c788ebb')).toBeNull();
    expect(getEvmProtocolVersion(4663, null)).toBeNull();
    expect(getEvmProtocolVersion(4663, 999)).toBeNull();
  });

  it('keeps versions and factories unique per chain', () => {
    for (const versions of Object.values(EVM_PROTOCOL_VERSIONS)) {
      expect(new Set(versions.map(v => v.version)).size).toBe(versions.length);
      expect(new Set(versions.map(v => v.factory.toLowerCase())).size).toBe(versions.length);
    }
  });

  const env = '0x00000000000000000000000000000000000000EE' as const;

  it('uses the address set of the vault version, not the environment', () => {
    const v8 = { chain_id: 4663, evm_protocol_version: 8 };
    const v9 = { chain_id: '4663', evm_protocol_version: 9 };
    expect(resolveVaultSwapAdapter(v8, env)).toBe('0xbA4fcCF341b91aEE7180A5Db242025141686EF76');
    expect(resolveVaultSwapAdapter(v9, env)).toBe('0x443FD443f2b5caab405170C984E9D7529a8bD0D0');
    expect(resolveVaultLpAdapter(v8, env)).toBe('0xdb4eF23bd896A247a1ac5bC70164855a273F21cb');
    expect(resolveVaultLpAdapter(v9, env)).toBe('0x757bdb2b9f65A16a2FC41C4dA5aebd58FE652212');
    expect(resolveVaultDeployBlock(v9, 1n)).toBe(104978002n);
  });

  it('falls back to the environment with no version, unknown version or unrecorded adapter', () => {
    expect(resolveVaultSwapAdapter({ chain_id: 4663, evm_protocol_version: null }, env)).toBe(env);
    expect(resolveVaultSwapAdapter({ chain_id: 4663, evm_protocol_version: 999 }, env)).toBe(env);
    expect(resolveVaultSwapAdapter({ chain_id: 46630, evm_protocol_version: 9 }, env)).toBe(env);
    expect(resolveVaultDeployBlock({ chain_id: 4663 }, 7n)).toBe(7n);
  });

  it('scans from the earliest factory of a chain', () => {
    expect(earliestEvmDeployBlock(4663)).toBe(94143837n);
    expect(earliestEvmDeployBlock(1)).toBeNull();
  });

  it('maps a fee converter to its version', () => {
    const v9 = getEvmProtocolVersion(4663, 9)!;
    expect(findEvmProtocolVersionByFeeConverter(4663, v9.feeConverter.toLowerCase())?.version).toBe(9);
    expect(findEvmProtocolVersionByFeeConverter(4663, env)).toBeNull();
  });
});

describe('EVM_PROTOCOL_VERSIONS numbering (deployment ids)', () => {
  for (const [chain, list] of Object.entries(EVM_PROTOCOL_VERSIONS)) {
    it(`chain ${chain}: ids are unique and only grow`, () => {
      const ids = list.map(v => v.version);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    });

    it(`chain ${chain}: stack matches the chain`, () => {
      for (const v of list) {
        if (Number(chain) === 46630) expect(v.stack).toBe('testnet');
        else expect(v.stack).not.toBe('testnet');
      }
    });

    it(`chain ${chain}: isV13Version (id >= 13) agrees with the code version`, () => {
      for (const v of list) expect(isV13Version(v.version)).toBe(v.codeVersion >= 13);
    });

    it(`chain ${chain}: no two deployments share a factory`, () => {
      const f = list.map(v => v.factory.toLowerCase());
      expect(new Set(f).size).toBe(f.length);
    });
  }
});

describe('termination asset caps', () => {
  it('every registered deployment so far has the legacy cap of 16', () => {
    for (const v of Object.values(EVM_PROTOCOL_VERSIONS).flat()) {
      expect(v.maxTerminationAssets ?? LEGACY_MAX_TERMINATION_ASSETS).toBe(16);
    }
  });

  it('a raised cap on a version flows into its basket cap', () => {
    const v14 = { ...EVM_PROTOCOL_VERSIONS[46630][0], version: 9_999, maxTerminationAssets: 56 };
    EVM_PROTOCOL_VERSIONS[46630].push(v14);
    try {
      const ref = { chain_id: 46630, evm_protocol_version: 9_999 };
      expect(terminationAssetCapFor(ref)).toBe(56);
      expect(basketAssetCapFor(ref)).toBe(50);
      expect(maxBasketAssetCapAnyVersion()).toBe(50);
    } finally {
      EVM_PROTOCOL_VERSIONS[46630].pop();
    }
  });

  it('unknown vaults and versions fall back to 16 / 15', () => {
    expect(terminationAssetCapFor(null)).toBe(16);
    expect(basketAssetCapFor({ chain_id: 4663, evm_protocol_version: null })).toBe(15);
    expect(basketAssetCapFor({ chain_id: 4663, evm_protocol_version: 123_456 })).toBe(15);
    expect(maxBasketAssetCapAnyVersion()).toBe(15);
  });

  it('currentEvmVersionRef resolves the factory in env', () => {
    const v = EVM_PROTOCOL_VERSIONS[4663][0];
    expect(currentEvmVersionRef({ EVM_CHAIN_ID: '4663', EVM_FACTORY_ADDRESS: v.factory })).toEqual({
      chain_id: 4663,
      evm_protocol_version: v.version,
    });
    expect(currentEvmVersionRef({ EVM_CHAIN_ID: '4663', EVM_FACTORY_ADDRESS: undefined }).evm_protocol_version).toBe(
      null
    );
  });
});
