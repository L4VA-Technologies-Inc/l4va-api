import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from '@jest/globals';

import { EvmAssetKindOnchain, EvmContributionStatus, EvmCycleStatus, EvmVaultOnchainStatus } from './vault.abi';

/**
 * Solidity enums are ordinal: the first variant is 0, second is 1, etc.
 * The values are declared in
 *   vault-contract-solidity/src/libraries/VaultTypes.sol
 * and this test parses that file directly so it will fail loudly if the
 * on-chain contract adds/reorders/removes enum variants without a matching
 * update to `vault.abi.ts`.
 *
 * The path is resolved relative to the workspace root — running the test
 * from a different CWD is unsupported.
 */
const VAULT_TYPES_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'vault-contract-solidity',
  'src',
  'libraries',
  'VaultTypes.sol'
);

/**
 * Parse `enum EnumName { A, B, C }` (single or multi-line) from Solidity.
 */
function parseSolidityEnum(source: string, enumName: string): string[] {
  // Match `enum EnumName { ... }` — non-greedy body capture.
  const re = new RegExp(`enum\\s+${enumName}\\s*{([^}]*)}`, 'm');
  const match = source.match(re);
  if (!match) {
    throw new Error(`enum ${enumName} not found in VaultTypes.sol`);
  }
  return match[1]
    .split(',')
    .map(v => v.replace(/\/\/.*$/gm, '').trim())
    .filter(v => v.length > 0);
}

describe('EVM enum parity with vault-contract-solidity/src/libraries/VaultTypes.sol', () => {
  let source: string;

  beforeAll(() => {
    source = readFileSync(VAULT_TYPES_PATH, 'utf8');
  });

  const cases: Array<{
    solidityEnum: string;
    tsEnum: Record<string, string | number>;
    expected: string[];
  }> = [
    {
      solidityEnum: 'CycleStatus',
      tsEnum: EvmCycleStatus,
      expected: ['Active', 'Locked', 'Cancelled'],
    },
    {
      solidityEnum: 'VaultStatus',
      tsEnum: EvmVaultOnchainStatus,
      expected: ['Pending', 'Active', 'Locked', 'Cancelled', 'TerminationPreparing', 'Terminating', 'Terminated'],
    },
    {
      solidityEnum: 'ContributionStatus',
      tsEnum: EvmContributionStatus,
      expected: ['Active', 'Cancelled'],
    },
    {
      solidityEnum: 'AssetKind',
      tsEnum: EvmAssetKindOnchain,
      expected: ['Native', 'ERC20', 'ERC721', 'ERC1155'],
    },
  ];

  it.each(cases)('$solidityEnum matches Solidity source ordinals', ({ solidityEnum, tsEnum, expected }) => {
    const parsed = parseSolidityEnum(source, solidityEnum);

    // Guard against silent drift if the Solidity contract is edited.
    expect(parsed).toEqual(expected);

    // Every Solidity variant must exist in the TS enum with the correct ordinal.
    parsed.forEach((variantName, ordinal) => {
      // Contract's `Cancelled` maps to TS `Cancelled` (VaultStatus / CycleStatus)
      // OR to TS ContributionStatus.Cancelled — both keys are present in each enum.
      expect(tsEnum[variantName]).toBe(ordinal);
    });

    // Reverse check: the TS enum must not have extra numeric entries beyond
    // what the Solidity contract exposes. TypeScript numeric enums are
    // reverse-mapped (both name→value and value→name), so filter to the
    // string keys before comparing.
    const tsNames = Object.keys(tsEnum).filter(k => Number.isNaN(Number(k)));
    expect(tsNames.sort()).toEqual([...parsed].sort());
  });
});
