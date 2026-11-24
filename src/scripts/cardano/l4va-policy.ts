import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import {
  Constr,
  Data,
  applyDoubleCborEncoding,
  applySingleCborEncoding,
  fromHex,
  fromText,
  getAddressDetails,
  mintingPolicyToId,
  toHex,
  type Credential,
  type MintingPolicy,
} from '@lucid-evolution/lucid';
import { apply_params_to_script } from '@lucid-evolution/uplc';

export type CardanoNetwork = 'Mainnet' | 'Preprod';

export const TOKEN_NAME = 'L4VA';
export const DECIMALS = 6;
export const MAX_SUPPLY = 100_000_000n * 10n ** BigInt(DECIMALS);

export const MINT_REDEEMER = Data.to(new Constr(0, []));
export const BURN_REDEEMER = Data.to(new Constr(1, []));

const BLUEPRINT_PATH = path.join(__dirname, 'l4va-token.plutus.json');
const VALIDATOR_TITLE = 'l4va.l4va.mint';
export const DEPLOYMENTS_DIR = path.join(__dirname, 'deployments');

export interface SeedRef {
  txHash: string;
  outputIndex: number;
}

export interface L4vaManifest {
  network: CardanoNetwork;
  status: 'pending' | 'submitted';
  seed: SeedRef;
  treasury: string;
  policyId: string;
  assetId: string;
  tokenName: string;
  decimals: number;
  maxSupply: string;
  script: string;
  compiler: string;
  validatorHash: string;
  sourceRevision: string;
  createdAt: string;
  txHash?: string;
  submittedAt?: string;
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function parseNetwork(value: string): CardanoNetwork {
  if (value !== 'Mainnet' && value !== 'Preprod') throw new Error(`NETWORK must be Mainnet or Preprod, got "${value}"`);
  return value;
}

export function blockfrostUrl(network: CardanoNetwork): string {
  return network === 'Mainnet'
    ? 'https://cardano-mainnet.blockfrost.io/api/v0'
    : 'https://cardano-preprod.blockfrost.io/api/v0';
}

export function assertAddressNetwork(label: string, address: string, network: CardanoNetwork): void {
  const expectedId = network === 'Mainnet' ? 1 : 0;
  const details = getAddressDetails(address);
  if (details.networkId !== expectedId) {
    throw new Error(`${label} ${address} is not a ${network} address`);
  }
}

export function parseSeed(value: string): SeedRef {
  const match = /^([0-9a-fA-F]{64})#(\d+)$/.exec(value);
  if (!match) throw new Error(`SEED_UTXO must be <txHash>#<index>, got "${value}"`);
  return { txHash: match[1].toLowerCase(), outputIndex: Number(match[2]) };
}

function credentialToData(credential: Credential): Constr<Data> {
  return new Constr(credential.type === 'Key' ? 0 : 1, [credential.hash]);
}

/** Plutus V3 `Address { payment_credential, stake_credential: Option<Referenced<Credential>> }`. */
export function addressToData(address: string): Constr<Data> {
  const details = getAddressDetails(address);
  if (!['Base', 'Enterprise'].includes(details.type) || !details.paymentCredential) {
    throw new Error(`Unsupported treasury address type "${details.type}" — use a base or enterprise address`);
  }
  const stake = details.stakeCredential
    ? new Constr(0, [new Constr(0, [credentialToData(details.stakeCredential)])])
    : new Constr(1, []);
  return new Constr(0, [credentialToData(details.paymentCredential), stake]);
}

export function seedToData(seed: SeedRef): Constr<Data> {
  return new Constr(0, [seed.txHash, BigInt(seed.outputIndex)]);
}

function loadBlueprint(): {
  compiledCode: string;
  hash: string;
  compiler: string;
} {
  const blueprint = JSON.parse(fs.readFileSync(BLUEPRINT_PATH, 'utf8'));
  const validator = blueprint.validators.find((v: { title: string }) => v.title === VALIDATOR_TITLE);
  if (!validator) throw new Error(`Validator ${VALIDATOR_TITLE} not found in ${BLUEPRINT_PATH}`);
  const { name, version } = blueprint.preamble.compiler;
  return {
    compiledCode: validator.compiledCode,
    hash: validator.hash,
    compiler: `${name} ${version}`,
  };
}

export function assetIdFor(policyId: string): string {
  return `${policyId}${fromText(TOKEN_NAME)}`;
}

export function applyL4vaParams(seed: SeedRef, treasuryAddress: string) {
  const blueprint = loadBlueprint();
  // Lucid's applyParamsToScript re-serializes data constants differently from `aiken blueprint apply`,
  // yielding a different policy id. The Aiken uplc apply reproduces the CLI byte-for-byte.
  const params = Data.to([seedToData(seed), addressToData(treasuryAddress)]);
  const applied = apply_params_to_script(fromHex(params), fromHex(applySingleCborEncoding(blueprint.compiledCode)));
  const policy: MintingPolicy = {
    type: 'PlutusV3',
    script: applyDoubleCborEncoding(toHex(applied)),
  };
  const policyId = mintingPolicyToId(policy);
  return {
    policy,
    policyId,
    assetId: assetIdFor(policyId),
    compiler: blueprint.compiler,
    validatorHash: blueprint.hash,
  };
}

export function manifestPath(network: CardanoNetwork, policyId: string): string {
  return path.join(DEPLOYMENTS_DIR, `${network.toLowerCase()}-${policyId}.json`);
}

export function writeManifest(manifest: L4vaManifest): string {
  fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  const file = manifestPath(manifest.network, manifest.policyId);
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return file;
}

export function readManifest(file: string): L4vaManifest {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Loads the saved, fully-applied script and proves it hashes to the recorded policy/asset. */
export function verifyManifest(manifest: L4vaManifest): MintingPolicy {
  const policy: MintingPolicy = { type: 'PlutusV3', script: manifest.script };
  const policyId = mintingPolicyToId(policy);
  if (policyId !== manifest.policyId) {
    throw new Error(`Manifest script hashes to ${policyId}, but manifest policyId is ${manifest.policyId}`);
  }
  if (manifest.assetId !== assetIdFor(policyId)) {
    throw new Error(`Manifest assetId ${manifest.assetId} does not match ${assetIdFor(policyId)}`);
  }
  if (
    manifest.tokenName !== TOKEN_NAME ||
    manifest.decimals !== DECIMALS ||
    manifest.maxSupply !== MAX_SUPPLY.toString()
  ) {
    throw new Error('Manifest token name/decimals/max supply do not match this script version');
  }
  return policy;
}

/** Parses a decimal L4VA amount (max 6 dp) or "ALL" into base units, bounded by balance. */
export function parseAmount(input: string | undefined, balance: bigint): bigint {
  const value = input?.trim();
  if (!value) throw new Error('BURN_AMOUNT is required (decimal L4VA, or ALL)');

  let units: bigint;
  if (value === 'ALL') {
    units = balance;
  } else {
    const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
    if (!match) {
      throw new Error(
        `BURN_AMOUNT "${value}" is invalid — use a positive number with at most ${DECIMALS} decimals, or ALL`
      );
    }
    units = BigInt(match[1]) * 10n ** BigInt(DECIMALS) + BigInt((match[2] ?? '').padEnd(DECIMALS, '0'));
  }

  if (units <= 0n) throw new Error('Burn amount must be greater than zero');
  if (units > balance) throw new Error(`Burn amount ${formatUnits(units)} exceeds balance ${formatUnits(balance)}`);
  return units;
}

export function formatUnits(units: bigint): string {
  const scale = 10n ** BigInt(DECIMALS);
  const whole = (units / scale).toLocaleString('en-US');
  const frac = (units % scale).toString().padStart(DECIMALS, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac} L4VA` : `${whole} L4VA`;
}

export function promptSecret(prompt: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    process.stdout.write(prompt);
    (rl as any)._writeToOutput = () => {};
    rl.question('', answer => {
      process.stdout.write('\n');
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function promptLine(prompt: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
