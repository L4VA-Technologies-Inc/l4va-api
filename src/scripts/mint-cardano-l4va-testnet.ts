/**
 * Testnet (preprod) version of the L4VA minting script.
 *
 * Mirrors the mainnet script: time-locked policy for fixed supply, 6 decimals.
 * Run this end to end before mainnet — the previous 18-decimal value overflowed
 * Cardano's int64 asset quantity, so this mint has almost certainly never
 * actually succeeded on preprod.
 *
 * Usage:
 *   BLOCKFROST_PROJECT_ID=preprodXXX \
 *   ADMIN_ADDRESS=addr_test1... \
 *   ADMIN_S_KEY=ed25519_sk1... \
 *   npx ts-node src/scripts/mint-cardano-l4va-testnet.ts
 */

import type { Assets } from '@lucid-evolution/core-types';
import { Lucid, Blockfrost } from '@lucid-evolution/lucid';
import { unixTimeToSlot } from '@lucid-evolution/utils';

import {
  DECIMALS,
  MAX_SUPPLY_TOKENS,
  TOTAL_SUPPLY,
  assertSupplyFitsLedger,
  buildL4VAPolicy,
} from './cardano-l4va-policy';

const BLOCKFROST_URL = 'https://cardano-preprod.blockfrost.io/api/v0';
const BLOCKFROST_PROJECT_ID = process.env.BLOCKFROST_PROJECT_ID;
const ADMIN_ADDRESS = process.env.ADMIN_ADDRESS;
const ADMIN_S_KEY = process.env.ADMIN_S_KEY;

if (!BLOCKFROST_PROJECT_ID) throw new Error('BLOCKFROST_PROJECT_ID not set');
if (!ADMIN_ADDRESS) throw new Error('ADMIN_ADDRESS not set');
if (!ADMIN_S_KEY) throw new Error('ADMIN_S_KEY not set');

/** Window in which the mint must complete; the policy locks forever after it. */
const LOCK_HOURS = Number(process.env.L4VA_POLICY_LOCK_HOURS ?? 24);

async function main() {
  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_PROJECT_ID), 'Preprod');

  const utxos = await lucid.utxosAt(ADMIN_ADDRESS);
  lucid.selectWallet.fromAddress(ADMIN_ADDRESS, utxos);

  const address = ADMIN_ADDRESS;
  console.log('[PREPROD] Wallet address:', address);
  console.log('UTXOs:', utxos.length);
  if (utxos.length === 0)
    throw new Error('Wallet has no UTXOs — fund via https://docs.cardano.org/cardano-testnets/tools/faucet');

  const lockUnixTime = Date.now() + LOCK_HOURS * 60 * 60 * 1000;
  const lockSlot = unixTimeToSlot('Preprod', lockUnixTime);

  const { policy, policyId, assetId } = buildL4VAPolicy(address, lockSlot);
  assertSupplyFitsLedger(TOTAL_SUPPLY);

  console.log('\n--- Policy info ---');
  console.log('Policy ID :', policyId);
  console.log('Asset ID  :', assetId);
  console.log('Decimals  :', DECIMALS);
  console.log('Supply    :', TOTAL_SUPPLY.toString(), `base units (= ${MAX_SUPPLY_TOKENS} L4VA)`);
  console.log('Lock slot :', lockSlot, `(${new Date(lockUnixTime).toISOString()})`);

  const assets: Assets = { [assetId]: TOTAL_SUPPLY };

  // Time-locked scripts need an explicit validity bound ending before the lock.
  const validTo = Date.now() + 30 * 60 * 1000;
  if (validTo >= lockUnixTime) throw new Error('Lock window too short to submit the mint');

  const txSignBuilder = await lucid
    .newTx()
    .mintAssets(assets)
    .attach.MintingPolicy(policy)
    .addSigner(address)
    .validTo(validTo)
    .complete();

  console.log('\nSigning...');
  const signedTx = await txSignBuilder.sign.withPrivateKey(ADMIN_S_KEY).complete();

  console.log('Submitting...');
  const txHash = await signedTx.submit();

  console.log('\n=== MINT SUCCESSFUL (PREPROD) ===');
  console.log('TX hash   :', txHash);
  console.log('Policy ID :', policyId);
  console.log('Asset ID  :', assetId);
  console.log('Lock slot :', lockSlot);
  console.log(`\nRecord it: export L4VA_POLICY_LOCK_SLOT=${lockSlot}`);
  console.log(`\nVerify: https://preprod.cardanoscan.io/transaction/${txHash}`);
  console.log('Burn via burn-cardano-l4va.ts with NETWORK=Preprod — only BEFORE the lock slot.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
