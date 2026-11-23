import { describe, expect, it } from '@jest/globals';
import { decodeErrorResult, encodeErrorResult, toFunctionSelector } from 'viem';

import { VAULT_ABI } from './vault.abi';

describe('VAULT_ABI custom errors', () => {
  it('decodes ExpansionWindowTooShort (stage closeCycle revert 0x89ecb62c)', () => {
    const data = encodeErrorResult({
      abi: VAULT_ABI,
      errorName: 'ExpansionWindowTooShort',
      args: [1_795_971_760n],
    });
    expect(data.slice(0, 10)).toBe('0x89ecb62c');
    const decoded = decodeErrorResult({ abi: VAULT_ABI, data });
    expect(decoded.errorName).toBe('ExpansionWindowTooShort');
    expect(decoded.args).toEqual([1_795_971_760n]);
  });

  it('has no two errors with the same selector', () => {
    const selectors = VAULT_ABI.filter(item => item.type === 'error').map(item =>
      toFunctionSelector(`${item.name}(${item.inputs.map(i => i.type).join(',')})`)
    );
    expect(new Set(selectors).size).toBe(selectors.length);
  });
});
