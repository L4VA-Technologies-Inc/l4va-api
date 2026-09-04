/**
 * Testnet (preprod) version of the L4VA minting script.
 *
 * Usage:
 *   BLOCKFROST_PROJECT_ID=preprodXXX \
 *   ADMIN_ADDRESS=addr_test1... \
 *   ADMIN_S_KEY=ed25519_sk1... \
 *   npx ts-node src/scripts/mint-cardano-l4va-testnet.ts
 */

import type { Assets, Native, PolicyId, Script } from '@lucid-evolution/core-types';
import { fromText } from '@lucid-evolution/core-utils';
import { Lucid, Blockfrost } from '@lucid-evolution/lucid';
import { getAddressDetails, mintingPolicyToId, scriptFromNative } from '@lucid-evolution/utils';

const BLOCKFROST_URL = 'https://cardano-preprod.blockfrost.io/api/v0';
const BLOCKFROST_PROJECT_ID = process.env.BLOCKFROST_PROJECT_ID;
const ADMIN_ADDRESS = process.env.ADMIN_ADDRESS;
const ADMIN_S_KEY = process.env.ADMIN_S_KEY;

if (!BLOCKFROST_PROJECT_ID) throw new Error('BLOCKFROST_PROJECT_ID not set');
if (!ADMIN_ADDRESS) throw new Error('ADMIN_ADDRESS not set');
if (!ADMIN_S_KEY) throw new Error('ADMIN_S_KEY not set');

const TOKEN_NAME = 'L4VA';
const DECIMALS = 6;
// 100,000,000 tokens × 10^6 (6 decimals) base units
const TOTAL_SUPPLY = 100_000_000n * 10n ** BigInt(DECIMALS);

async function main() {
  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_PROJECT_ID), 'Preprod');

  const utxos = await lucid.utxosAt(ADMIN_ADDRESS);
  lucid.selectWallet.fromAddress(ADMIN_ADDRESS, utxos);

  const address = ADMIN_ADDRESS;
  console.log('[PREPROD] Wallet address:', address);
  console.log('UTXOs:', utxos.length);
  if (utxos.length === 0)
    throw new Error('Wallet has no UTXOs — fund via https://docs.cardano.org/cardano-testnets/tools/faucet');

  const { paymentCredential } = getAddressDetails(address);
  if (!paymentCredential) throw new Error('Cannot derive payment credential from address');

  // Sig-only: same key can burn later via burn-cardano-l4va.ts
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
  const signedTx = await txSignBuilder.sign.withPrivateKey(ADMIN_S_KEY).complete();

  console.log('Submitting...');
  const txHash = await signedTx.submit();

  console.log('\n=== MINT SUCCESSFUL (PREPROD) ===');
  console.log('TX hash   :', txHash);
  console.log('Policy ID :', policyId);
  console.log('Asset ID  :', assetId);
  console.log('Lock slot :', '(none — sig-only policy, burn is always possible)');
  console.log(`\nVerify: https://preprod.cardanoscan.io/transaction/${txHash}`);
  console.log('Burn L4VA anytime via burn-cardano-l4va.ts with NETWORK=Preprod.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
