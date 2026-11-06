import { describe, expect, it } from '@jest/globals';

import {
  earliestEvmDeployBlock,
  EVM_PROTOCOL_VERSIONS,
  findEvmProtocolVersionByFactory,
  findEvmProtocolVersionByFeeConverter,
  getEvmProtocolVersion,
  resolveVaultDeployBlock,
  resolveVaultLpAdapter,
  resolveVaultSwapAdapter,
} from './evm-protocol-versions';

describe('evm protocol versions', () => {
  it('finds a version by factory, case-insensitively and per chain', () => {
    expect(findEvmProtocolVersionByFactory(4663, '0xf933f971dd670648162b393f02f718e49c788ebb')?.version).toBe(9);
    expect(findEvmProtocolVersionByFactory(4663, '0x7Eb5c9F3FE05C8e924BC4d1792D8C0Eb07fccC05')?.version).toBe(8);
    expect(findEvmProtocolVersionByFactory(4663, '0xceC9F4A79e3FF744aF845b6379561c570dc54CCf')?.version).toBe(10);
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
