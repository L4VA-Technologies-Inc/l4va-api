/**
 * One-time script: mint 100,000,000 L4VA on Cardano mainnet.
 *
 * Policy: TIME-LOCKED native script — `all [sig <admin>, before <lockSlot>]`.
 * The admin key can mint until `lockSlot`; after it the script can never
 * validate again, so supply is fixed by the ledger rather than by promise.
 * See src/scripts/cardano-l4va-policy.ts for the full rationale.
 *
 * Decided 04.09.2026 (Rob: "Ok then prob fixed supply on cardano").
 *
 * NOTE: locking prevents burning too — Cardano native scripts cannot tell a
 * burn from a mint. burn-cardano-l4va.ts only works BEFORE the lock passes.
 *
 * Usage:
 *   BLOCKFROST_PROJECT_ID=mainnetXXX \
 *   ADMIN_ADDRESS=addr1... \
 *   L4VA_POLICY_LOCK_HOURS=24 \   # optional, default 24
 *   npx ts-node src/scripts/mint-cardano-l4va.ts
 *
 * ADMIN_S_KEY will be prompted securely (no echo) if not set in the environment.
 *
 * ONLY MINT ONCE. Record the printed lock slot — the policy ID depends on it,
 * so every later script must use the same value or it derives a different asset.
 */

import * as readline from 'readline';

import type { Assets } from '@lucid-evolution/core-types';
// L4VA token spec (Cardano):
//   Token Name        : L4VA
//   Symbol / Ticker   : L4VA
//   Short Description  : The protocol token powering programmable capital markets.
//   Decimals          : 6
//   Category          : Protocol / Capital Markets Infrastructure
//   Website           : https://l4va.com
//   App               : https://app.l4va.org
//   Max Supply        : 100,000,000 L4VA
import { Lucid, Blockfrost } from '@lucid-evolution/lucid';
import { unixTimeToSlot } from '@lucid-evolution/utils';

import {
  DECIMALS,
  MAX_SUPPLY_TOKENS,
  TICKER,
  TOKEN_NAME,
  TOTAL_SUPPLY,
  assertSupplyFitsLedger,
  buildL4VAPolicy,
} from './cardano-l4va-policy';

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

const DESCRIPTION = 'The protocol token powering programmable capital markets.';
const WEBSITE = 'https://l4va.com';

/** Window in which the mint must complete; the policy locks forever after it. */
const LOCK_HOURS = Number(process.env.L4VA_POLICY_LOCK_HOURS ?? 24);

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

  if (!Number.isFinite(LOCK_HOURS) || LOCK_HOURS <= 0) {
    throw new Error(`L4VA_POLICY_LOCK_HOURS must be positive (got ${LOCK_HOURS})`);
  }

  // The policy locks at this slot. Baked into the script, so it fixes the
  // policy ID — record the printed value.
  const lockUnixTime = Date.now() + LOCK_HOURS * 60 * 60 * 1000;
  const lockSlot = unixTimeToSlot('Mainnet', lockUnixTime);

  const { policy, policyId, assetId } = buildL4VAPolicy(address, lockSlot);

  // Guard against ever re-introducing the int64 overflow that 18 decimals caused.
  assertSupplyFitsLedger(TOTAL_SUPPLY);

  console.log('\n--- Policy info ---');
  console.log('Policy ID :', policyId);
  console.log('Asset ID  :', assetId);
  console.log('Decimals  :', DECIMALS);
  console.log('Supply    :', TOTAL_SUPPLY.toString(), `base units (= ${MAX_SUPPLY_TOKENS} L4VA)`);
  console.log('Lock slot :', lockSlot, `(${new Date(lockUnixTime).toISOString()})`);
  console.log('           after this slot the policy can NEVER mint or burn again');

  const assets: Assets = { [assetId]: TOTAL_SUPPLY };

  // A time-locked script requires an explicit validity upper bound, and it must
  // end before lockSlot or the transaction cannot satisfy the policy.
  const validTo = Date.now() + 30 * 60 * 1000; // 30 minutes
  if (validTo >= lockUnixTime) throw new Error('Lock window too short to submit the mint');

  const txSignBuilder = await lucid
    .newTx()
    .mintAssets(assets)
    .attach.MintingPolicy(policy)
    .addSigner(address)
    .validTo(validTo)
    .complete();

  console.log('\nSigning...');
  const signedTx = await txSignBuilder.sign.withPrivateKey(adminSKey).complete();

  console.log('Submitting...');
  const txHash = await signedTx.submit();

  console.log('\n=== MINT SUCCESSFUL ===');
  console.log('TX hash   :', txHash);
  console.log('Policy ID :', policyId);
  console.log('Asset ID  :', assetId);
  console.log('Lock slot :', lockSlot);
  console.log('\nSave policyId + tokenNameHex — they identify L4VA on Cardano forever.');
  console.log(`Save the lock slot too: export L4VA_POLICY_LOCK_SLOT=${lockSlot}`);
  console.log('The policy ID is derived from it; without it later scripts derive a DIFFERENT asset.');
  console.log('');
  console.log(`Supply becomes permanently fixed at ${new Date(lockUnixTime).toISOString()}.`);
  console.log('Until then the admin key can still mint or burn — move it to cold storage now.');

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
