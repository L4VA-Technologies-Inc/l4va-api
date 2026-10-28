/**
 * Copy the contract artifacts the lifecycle suite deploys from ../vault-contract-solidity.
 * Only ABI + bytecode are kept; SOURCE.md records which contracts commit they came from.
 *
 *   npm run test:lifecycle:sync-contracts [-- /path/to/vault-contract-solidity]
 */
import { execSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

const CONTRACTS = ['VaultFactory', 'BatchVaultDeployer', 'ProtocolFeeConfig', 'MockERC20'];

const repo = resolve(process.argv[2] ?? join(__dirname, '../../../../vault-contract-solidity'));
const outDir = join(__dirname, '../artifacts');

// `forge build src` sidesteps a pre-existing lint failure under test/.
execSync('forge build src', { cwd: repo, stdio: 'inherit' });
mkdirSync(outDir, { recursive: true });

for (const name of CONTRACTS) {
  const artifact = JSON.parse(readFileSync(join(repo, 'out', `${name}.sol`, `${name}.json`), 'utf8'));
  writeFileSync(
    join(outDir, `${name}.json`),
    JSON.stringify({ contractName: name, abi: artifact.abi, bytecode: artifact.bytecode.object }) + '\n'
  );
}

const commit = execSync('git rev-parse HEAD', { cwd: repo }).toString().trim();
const dirty = execSync('git status --porcelain src', { cwd: repo }).toString().trim() !== '';
writeFileSync(
  join(outDir, 'SOURCE.md'),
  `Built from vault-contract-solidity ${commit}${dirty ? ' (with uncommitted changes in src/)' : ''}\n` +
    `Contracts: ${CONTRACTS.join(', ')}\n`
);
console.log(`Synced ${CONTRACTS.length} artifacts from ${commit}`);
