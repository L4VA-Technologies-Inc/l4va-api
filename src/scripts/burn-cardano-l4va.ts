/**
 * Burn L4VA from any holder wallet — a negative mint that permanently reduces on-chain supply.
 * No admin key: the Aiken policy lets anyone burn L4VA they can spend.
 *
 * Usage (every variable is required):
 *   NETWORK=Preprod|Mainnet \
 *   BLOCKFROST_PROJECT_ID=... \
 *   L4VA_MANIFEST=src/scripts/cardano/deployments/<network>-<policyId>.json \
 *   HOLDER_ADDRESS=addr... \
 *   BURN_AMOUNT=1000.5 \      # decimal L4VA (max 6 dp), or ALL
 *   npx ts-node src/scripts/burn-cardano-l4va.ts
 *
 * HOLDER_S_KEY is prompted without echo if not set. You must type BURN to confirm.
 */

import { Blockfrost, Lucid } from '@lucid-evolution/lucid';

import {
  BURN_REDEEMER,
  assertAddressNetwork,
  blockfrostUrl,
  formatUnits,
  parseAmount,
  parseNetwork,
  promptLine,
  promptSecret,
  readManifest,
  requireEnv,
  verifyManifest,
} from './cardano/l4va-policy';

async function main() {
  const network = parseNetwork(requireEnv('NETWORK'));
  const blockfrostProjectId = requireEnv('BLOCKFROST_PROJECT_ID');
  const manifestFile = requireEnv('L4VA_MANIFEST');
  const holderAddress = requireEnv('HOLDER_ADDRESS');
  const burnAmountInput = requireEnv('BURN_AMOUNT');

  const manifest = readManifest(manifestFile);
  const policy = verifyManifest(manifest);
  if (manifest.network !== network) {
    throw new Error(`Manifest is for ${manifest.network}, but NETWORK=${network}`);
  }
  assertAddressNetwork('HOLDER_ADDRESS', holderAddress, network);

  const lucid = await Lucid(new Blockfrost(blockfrostUrl(network), blockfrostProjectId), network);
  const utxos = await lucid.utxosAt(holderAddress);
  const balance = utxos.reduce((sum, u) => sum + (u.assets[manifest.assetId] ?? 0n), 0n);
  const amount = parseAmount(burnAmountInput, balance);

  console.log(`Network  : ${network}`);
  console.log(`Holder   : ${holderAddress}`);
  console.log(`Asset ID : ${manifest.assetId}`);
  console.log(`Balance  : ${formatUnits(balance)}`);
  console.log(`Burning  : ${formatUnits(amount)} (${amount} base units) — irreversible`);

  if ((await promptLine('Type BURN to confirm: ')) !== 'BURN') throw new Error('Aborted');

  const holderSKey = process.env.HOLDER_S_KEY?.trim() || (await promptSecret('HOLDER_S_KEY: '));
  if (!holderSKey) throw new Error('HOLDER_S_KEY is required');

  lucid.selectWallet.fromAddress(holderAddress, utxos);
  const txSignBuilder = await lucid
    .newTx()
    .mintAssets({ [manifest.assetId]: -amount }, BURN_REDEEMER)
    .attach.MintingPolicy(policy)
    .complete();
  const signedTx = await txSignBuilder.sign.withPrivateKey(holderSKey).complete();
  const txHash = await signedTx.submit();

  console.log('\n=== BURN SUBMITTED ===');
  console.log(`TX hash : ${txHash}`);
  const explorer = network === 'Preprod' ? 'https://preprod.cardanoscan.io' : 'https://cardanoscan.io';
  console.log(`Verify  : ${explorer}/transaction/${txHash}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
