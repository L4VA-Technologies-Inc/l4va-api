/**
 * One-time script: mint 100,000,000 L4VA on Cardano mainnet.
 *
 * Policy: sig-only native script — only the ADMIN key can mint or burn.
 * Supply is fixed at 100 M by organizational commitment; the key goes into cold
 * storage after minting. Burns remain possible forever via burn-cardano-l4va.ts.
 *
 * Usage:
 *   BLOCKFROST_PROJECT_ID=mainnetXXX \
 *   ADMIN_ADDRESS=addr1... \
 *   npx ts-node src/scripts/mint-cardano-l4va.ts
 *
 * ADMIN_S_KEY will be prompted securely (no echo) if not set in the environment.
 *
 * ONLY MINT ONCE. Move key to cold storage immediately after.
 */

import * as readline from 'readline';

import type { Assets, Native, PolicyId, Script } from '@lucid-evolution/core-types';
// L4VA token spec (Cardano):
//   Token Name        : L4VA
//   Symbol / Ticker   : L4VA
//   Short Description  : The protocol token powering programmable capital markets.
//   Decimals          : 6
//   Category          : Protocol / Capital Markets Infrastructure
//   Website           : https://l4va.com
//   App               : https://app.l4va.org
//   Max Supply        : 100,000,000 L4VA
import { fromText } from '@lucid-evolution/core-utils';
import { Lucid, Blockfrost } from '@lucid-evolution/lucid';
import { getAddressDetails, mintingPolicyToId, scriptFromNative } from '@lucid-evolution/utils';

function promptSecret(prompt: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(prompt);
    // suppress echoing of typed characters
    (rl as any)._writeToOutput = () => {};
    rl.question('', answer => {
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

const BLOCKFROST_URL = 'https://cardano-mainnet.blockfrost.io/api/v0';
const BLOCKFROST_PROJECT_ID = process.env.BLOCKFROST_PROJECT_ID;
const ADMIN_ADDRESS = process.env.ADMIN_ADDRESS;

if (!BLOCKFROST_PROJECT_ID) throw new Error('BLOCKFROST_PROJECT_ID not set');
if (!ADMIN_ADDRESS) throw new Error('ADMIN_ADDRESS not set');

const TOKEN_NAME = 'L4VA';
const TICKER = 'L4VA';
const DESCRIPTION = 'The protocol token powering programmable capital markets.';
const DECIMALS = 6;
const WEBSITE = 'https://l4va.com';
const MAX_SUPPLY_TOKENS = 100_000_000n;
// 100,000,000 tokens × 10^6 (6 decimals) base units
const TOTAL_SUPPLY = MAX_SUPPLY_TOKENS * 10n ** BigInt(DECIMALS);

async function main() {
  const adminSKey = process.env.ADMIN_S_KEY || (await promptSecret('ADMIN_S_KEY: '));
  if (!adminSKey) throw new Error('ADMIN_S_KEY is required');

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_PROJECT_ID), 'Mainnet');

  const utxos = await lucid.utxosAt(ADMIN_ADDRESS);
  lucid.selectWallet.fromAddress(ADMIN_ADDRESS, utxos);

  const address = ADMIN_ADDRESS;
  console.log('Wallet address:', address);
  console.log('UTXOs:', utxos.length);
  if (utxos.length === 0) throw new Error('Wallet has no UTXOs — fund it with ADA first');

  const { paymentCredential } = getAddressDetails(address);
  if (!paymentCredential) throw new Error('Cannot derive payment credential from address');

  // Sig-only: only this key can mint or burn. Move key to cold storage after minting.
  const nativeScript: Native = {
    type: 'sig',
    keyHash: paymentCredential.hash,
  };

  const policy: Script = scriptFromNative(nativeScript);
  const policyId: PolicyId = mintingPolicyToId(policy);
  const tokenNameHex = fromText(TOKEN_NAME);
  const assetId = `${policyId}${tokenNameHex}`;

  console.log('\n--- Policy info ---');
  console.log('Policy ID :', policyId);
  console.log('Asset ID  :', assetId);
  console.log('Decimals  :', DECIMALS);
  console.log('Supply    :', TOTAL_SUPPLY.toString(), 'base units (= 100,000,000 L4VA)');

  const assets: Assets = { [assetId]: TOTAL_SUPPLY };

  const txSignBuilder = await lucid
    .newTx()
    .mintAssets(assets)
    .attach.MintingPolicy(policy)
    .addSigner(address)
    .complete();

  console.log('\nSigning...');
  const signedTx = await txSignBuilder.sign.withPrivateKey(adminSKey).complete();

  console.log('Submitting...');
  const txHash = await signedTx.submit();

  console.log('\n=== MINT SUCCESSFUL ===');
  console.log('TX hash   :', txHash);
  console.log('Policy ID :', policyId);
  console.log('Asset ID  :', assetId);
  console.log('Lock slot :', '(none — sig-only policy, burn always possible)');
  console.log('\nSave policyId + tokenNameHex — they identify L4VA on Cardano forever.');
  console.log('Move ADMIN_S_KEY to cold storage now. Burns remain possible via burn-cardano-l4va.ts.');

  // CIP-26 Cardano Token Registry entry — submit as a PR to
  // https://github.com/cardano-foundation/cardano-token-registry
  // (fields requiring signatures — name/description/ticker/decimals — must be
  // signed with the policy key via the `token-metadata-creator` tool).
  const registryEntry = {
    subject: assetId,
    policy: policy.script,
    name: { value: TOKEN_NAME },
    description: { value: DESCRIPTION },
    ticker: { value: TICKER },
    decimals: { value: DECIMALS },
    url: { value: WEBSITE },
    logo: { value: '<base64-encoded square transparent PNG of the official L4VA mark>' },
  };
  console.log('\n--- CIP-26 token registry entry (draft) ---');
  console.log(JSON.stringify(registryEntry, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
