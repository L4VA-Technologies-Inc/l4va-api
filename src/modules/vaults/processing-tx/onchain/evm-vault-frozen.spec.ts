import { describe, expect, it } from '@jest/globals';
import {
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  encodeErrorResult,
  toFunctionSelector,
  type Address,
} from 'viem';

import {
  expansionWindowTooShortRevert,
  isExpansionWindowTooShortReason,
  isVaultFrozenRevert,
} from './evm-admin-signer.service';
import { readVaultFrozen } from './evm-pause.service';
import { VAULT_ABI } from './vault.abi';

const VAULT = '0x00000000000000000000000000000000000000aa' as Address;

const reverted = (data: `0x${string}`): ContractFunctionRevertedError =>
  new ContractFunctionRevertedError({ abi: VAULT_ABI, data, functionName: 'pause' });

describe('isVaultFrozenRevert', () => {
  it('recognises the VaultFrozen() revert', () => {
    expect(isVaultFrozenRevert(reverted(toFunctionSelector('VaultFrozen()')))).toBe(true);
  });

  it('recognises it by selector when the ABI in use lacks the error', () => {
    const err = new ContractFunctionRevertedError({
      abi: [],
      data: toFunctionSelector('VaultFrozen()'),
      functionName: 'closeCycle',
    });
    expect(isVaultFrozenRevert(err)).toBe(true);
  });

  it('ignores other reverts and non-viem errors', () => {
    expect(
      isVaultFrozenRevert(reverted(`${toFunctionSelector('NotAuthority(address)')}${'00'.repeat(32)}` as `0x${string}`))
    ).toBe(false);
    expect(isVaultFrozenRevert(new Error('VaultFrozen'))).toBe(false);
  });
});

describe('readVaultFrozen', () => {
  const client = (impl: () => Promise<unknown>): { readContract: () => Promise<unknown> } => ({ readContract: impl });

  it('returns the on-chain flag for V11+ vaults', async () => {
    await expect(
      readVaultFrozen(
        client(async () => true),
        VAULT
      )
    ).resolves.toBe(true);
    await expect(
      readVaultFrozen(
        client(async () => false),
        VAULT
      )
    ).resolves.toBe(false);
  });

  it('reads vaults without frozen() (V8–V10) as not frozen', async () => {
    const noFunction = client(async () => {
      throw reverted('0x');
    });
    await expect(readVaultFrozen(noFunction, VAULT)).resolves.toBe(false);

    const zeroData = client(async () => {
      throw new ContractFunctionZeroDataError({ functionName: 'frozen' });
    });
    await expect(readVaultFrozen(zeroData, VAULT)).resolves.toBe(false);
  });

  it('never reads an RPC failure as "not frozen"', async () => {
    const down = client(async () => {
      throw new Error('fetch failed');
    });
    await expect(readVaultFrozen(down, VAULT)).rejects.toThrow('fetch failed');
  });
});

describe('expansionWindowTooShortRevert', () => {
  const data = encodeErrorResult({ abi: VAULT_ABI, errorName: 'ExpansionWindowTooShort', args: [1_795_539_759n] });

  it('returns earliestClose for the decoded revert', () => {
    const err = new ContractFunctionRevertedError({ abi: VAULT_ABI, data, functionName: 'closeCycle' });
    expect(expansionWindowTooShortRevert(err)).toBe(1_795_539_759n);
  });

  it('recognises it by selector when the ABI in use lacks the error', () => {
    const err = new ContractFunctionRevertedError({ abi: [], data, functionName: 'closeCycle' });
    expect(expansionWindowTooShortRevert(err)).toBeNull();
  });

  it('ignores other reverts and non-viem errors', () => {
    expect(expansionWindowTooShortRevert(reverted(toFunctionSelector('VaultFrozen()')))).toBeUndefined();
    expect(expansionWindowTooShortRevert(new Error('ExpansionWindowTooShort'))).toBeUndefined();
  });
});

describe('isExpansionWindowTooShortReason', () => {
  it('matches the stored stage failure (undecoded selector) and decoded names', () => {
    expect(
      isExpansionWindowTooShortReason(
        'broadcast: The contract function "closeCycle" reverted with the following signature:\n0x89ecb62c'
      )
    ).toBe(true);
    expect(isExpansionWindowTooShortReason('broadcast: ... ExpansionWindowTooShort(1795539759)')).toBe(true);
    expect(isExpansionWindowTooShortReason('broadcast: NotAuthority')).toBe(false);
    expect(isExpansionWindowTooShortReason(null)).toBe(false);
  });
});
