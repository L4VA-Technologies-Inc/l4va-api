/**
 * True burn of L4VA tokens on Cardano — mints a negative quantity, permanently
 * reducing on-chain supply. Requires the ADMIN_S_KEY that controls the sig-only
 * minting policy used during initial mint.
 *
 * Usage:
 *   BLOCKFROST_PROJECT_ID=mainnetXXX \
 *   ADMIN_ADDRESS=addr1... \
 *   ADMIN_S_KEY=ed25519e_sk1... \
 *   L4VA_ASSET_ID=<policyId><tokenNameHex> \
 *   BURN_AMOUNT=1000000000 \       # base units (optional — omit to burn all)
 *   npx ts-node src/scripts/burn-cardano-l4va.ts
 *
 * For preprod set NETWORK=Preprod and use preprod Blockfrost project ID.
 */

import type { Native, Script, UTxO } from '@lucid-evolution/core-types';
import { Lucid, Blockfrost } from '@lucid-evolution/lucid';
import { getAddressDetails, mintingPolicyToId, scriptFromNative } from '@lucid-evolution/utils';

const NETWORK = (process.env.NETWORK ?? 'Mainnet') as 'Mainnet' | 'Preprod';
const BLOCKFROST_URL =
  NETWORK === 'Preprod'
    ? 'https://cardano-preprod.blockfrost.io/api/v0'
    : 'https://cardano-mainnet.blockfrost.io/api/v0';

const BLOCKFROST_PROJECT_ID = process.env.BLOCKFROST_PROJECT_ID;
const ADMIN_ADDRESS = process.env.ADMIN_ADDRESS;
const ADMIN_S_KEY = process.env.ADMIN_S_KEY;
const L4VA_ASSET_ID = process.env.L4VA_ASSET_ID;
// If omitted, burn all L4VA in the wallet
const BURN_AMOUNT = process.env.BURN_AMOUNT ? BigInt(process.env.BURN_AMOUNT) : null;

if (!BLOCKFROST_PROJECT_ID) throw new Error('BLOCKFROST_PROJECT_ID not set');
if (!ADMIN_ADDRESS) throw new Error('ADMIN_ADDRESS not set');
if (!ADMIN_S_KEY) throw new Error('ADMIN_S_KEY not set');
if (!L4VA_ASSET_ID) throw new Error('L4VA_ASSET_ID not set (policyId + tokenNameHex)');

async function main() {
  console.log(`Network : ${NETWORK}`);

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_PROJECT_ID), NETWORK);

  const utxos: UTxO[] = await lucid.utxosAt(ADMIN_ADDRESS);
  lucid.selectWallet.fromAddress(ADMIN_ADDRESS, utxos);

  console.log(`Wallet  : ${ADMIN_ADDRESS}`);
  console.log(`UTXOs   : ${utxos.length}`);
  if (utxos.length === 0) throw new Error('Wallet has no UTXOs');

  // Reconstruct the sig-only policy from the minting address
  const { paymentCredential } = getAddressDetails(ADMIN_ADDRESS);
  if (!paymentCredential) throw new Error('Cannot derive payment credential from address');

  const nativeScript: Native = { type: 'sig', keyHash: paymentCredential.hash };
  const policy: Script = scriptFromNative(nativeScript);
  const policyId = mintingPolicyToId(policy);

  // Sanity check: the derived policyId must match the L4VA_ASSET_ID prefix
  if (!L4VA_ASSET_ID.startsWith(policyId)) {
    throw new Error(
      `Policy mismatch: derived policyId ${policyId} does not match L4VA_ASSET_ID.\n` +
        `Ensure ADMIN_ADDRESS is the same wallet used to mint.`
    );
  }

  // Sum all L4VA across UTXOs
  const totalL4va = utxos.reduce((sum, utxo) => sum + (utxo.assets[L4VA_ASSET_ID] ?? 0n), 0n);
  if (totalL4va === 0n) throw new Error(`No L4VA found in wallet (asset: ${L4VA_ASSET_ID})`);

  const amountToBurn = BURN_AMOUNT !== null ? BURN_AMOUNT : totalL4va;
  if (amountToBurn > totalL4va) {
    throw new Error(`Requested ${amountToBurn} but wallet only has ${totalL4va} base units`);
  }

  const humanAmount = Number(amountToBurn) / 1e6; // 6 decimals
  console.log(`\nL4VA in wallet : ${totalL4va} base units`);
  console.log(`Burning (true) : ${amountToBurn} base units (= ${humanAmount.toLocaleString()} L4VA)`);

  // Negative mint = true on-chain burn, permanently reduces totalSupply
  const txSignBuilder = await lucid
    .newTx()
    .mintAssets({ [L4VA_ASSET_ID]: -amountToBurn })
    .attach.MintingPolicy(policy)
    .addSigner(ADMIN_ADDRESS)
    .complete();

  console.log('\nSigning...');
  const signedTx = await txSignBuilder.sign.withPrivateKey(ADMIN_S_KEY).complete();

  console.log('Submitting...');
  const txHash = await signedTx.submit();

  console.log('\n=== BURN SUCCESSFUL ===');
  console.log('TX hash  :', txHash);
  console.log('Asset ID :', L4VA_ASSET_ID);
  console.log('Burned   :', amountToBurn.toString(), 'base units (totalSupply reduced on-chain)');
  if (NETWORK === 'Preprod') {
    console.log(`Verify: https://preprod.cardanoscan.io/transaction/${txHash}`);
  } else {
    console.log(`Verify: https://cardanoscan.io/transaction/${txHash}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
