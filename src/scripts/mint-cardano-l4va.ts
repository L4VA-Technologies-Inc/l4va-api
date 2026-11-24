/**
 * One-shot mint of 100,000,000 L4VA (6 decimals) under the Aiken policy in l4va-token.
 *
 * The policy is parameterized by SEED_UTXO and TREASURY_ADDRESS: it only validates a mint that
 * spends the seed and sends the full supply to the treasury, so it can never run twice.
 * Holders can burn later via burn-cardano-l4va.ts without any admin key.
 *
 * Usage (every variable is required — no defaults):
 *   NETWORK=Preprod|Mainnet \
 *   BLOCKFROST_PROJECT_ID=... \
 *   ADMIN_ADDRESS=addr... \            # wallet that owns SEED_UTXO and pays fees
 *   SEED_UTXO=<txHash>#<index> \       # a UTxO at ADMIN_ADDRESS, chosen deliberately
 *   TREASURY_ADDRESS=addr... \         # receives the full supply (enforced on-chain)
 *   SOURCE_REVISION=<l4va-token commit> \
 *   npx ts-node src/scripts/mint-cardano-l4va.ts
 *
 * ADMIN_S_KEY is prompted without echo if not set in the environment.
 * A deployment manifest (with the fully applied script) is written to
 * src/scripts/cardano/deployments/ BEFORE submission. Keep it: burns load the policy from it.
 */

import * as fs from 'fs';

import { Blockfrost, Lucid } from '@lucid-evolution/lucid';

import {
  DECIMALS,
  MAX_SUPPLY,
  MINT_REDEEMER,
  TOKEN_NAME,
  applyL4vaParams,
  assertAddressNetwork,
  blockfrostUrl,
  formatUnits,
  manifestPath,
  parseNetwork,
  parseSeed,
  promptSecret,
  readManifest,
  requireEnv,
  writeManifest,
  type L4vaManifest,
} from './cardano/l4va-policy';

const DESCRIPTION = 'The protocol token powering programmable capital markets.';
const WEBSITE = 'https://l4va.com';

async function main() {
  const network = parseNetwork(requireEnv('NETWORK'));
  const blockfrostProjectId = requireEnv('BLOCKFROST_PROJECT_ID');
  const adminAddress = requireEnv('ADMIN_ADDRESS');
  const seed = parseSeed(requireEnv('SEED_UTXO'));
  const treasuryAddress = requireEnv('TREASURY_ADDRESS');
  const sourceRevision = requireEnv('SOURCE_REVISION');

  assertAddressNetwork('ADMIN_ADDRESS', adminAddress, network);
  assertAddressNetwork('TREASURY_ADDRESS', treasuryAddress, network);

  const lucid = await Lucid(new Blockfrost(blockfrostUrl(network), blockfrostProjectId), network);
  const utxos = await lucid.utxosAt(adminAddress);
  const seedUtxo = utxos.find(u => u.txHash === seed.txHash && u.outputIndex === seed.outputIndex);
  if (!seedUtxo) {
    throw new Error(
      `SEED_UTXO ${seed.txHash}#${seed.outputIndex} not found at ADMIN_ADDRESS — spent or not owned by admin`
    );
  }
  lucid.selectWallet.fromAddress(adminAddress, utxos);

  const { policy, policyId, assetId, compiler, validatorHash } = applyL4vaParams(seed, treasuryAddress);
  const file = manifestPath(network, policyId);
  if (fs.existsSync(file) && readManifest(file).txHash) {
    throw new Error(`Already minted: ${file} records tx ${readManifest(file).txHash}`);
  }

  console.log(`Network   : ${network}`);
  console.log(`Admin     : ${adminAddress}`);
  console.log(`Seed      : ${seed.txHash}#${seed.outputIndex}`);
  console.log(`Treasury  : ${treasuryAddress}`);
  console.log(`Policy ID : ${policyId}`);
  console.log(`Asset ID  : ${assetId}`);
  console.log(`Supply    : ${MAX_SUPPLY} base units (= ${formatUnits(MAX_SUPPLY)})`);

  const adminSKey = process.env.ADMIN_S_KEY?.trim() || (await promptSecret('ADMIN_S_KEY: '));
  if (!adminSKey) throw new Error('ADMIN_S_KEY is required');

  const txSignBuilder = await lucid
    .newTx()
    .collectFrom([seedUtxo])
    .mintAssets({ [assetId]: MAX_SUPPLY }, MINT_REDEEMER)
    .attach.MintingPolicy(policy)
    .pay.ToAddress(treasuryAddress, { [assetId]: MAX_SUPPLY })
    .addSigner(adminAddress)
    .complete();
  const signedTx = await txSignBuilder.sign.withPrivateKey(adminSKey).complete();

  const manifest: L4vaManifest = {
    network,
    status: 'pending',
    seed,
    treasury: treasuryAddress,
    policyId,
    assetId,
    tokenName: TOKEN_NAME,
    decimals: DECIMALS,
    maxSupply: MAX_SUPPLY.toString(),
    script: policy.script,
    compiler,
    validatorHash,
    sourceRevision,
    createdAt: new Date().toISOString(),
  };
  writeManifest(manifest);
  console.log(`\nManifest written (pending): ${file}`);

  console.log('Submitting...');
  const txHash = await signedTx.submit();
  writeManifest({
    ...manifest,
    status: 'submitted',
    txHash,
    submittedAt: new Date().toISOString(),
  });

  console.log('\n=== MINT SUBMITTED ===');
  console.log(`TX hash   : ${txHash}`);
  console.log(`Manifest  : ${file}  (commit it — burns need it)`);
  const explorer = network === 'Preprod' ? 'https://preprod.cardanoscan.io' : 'https://cardanoscan.io';
  console.log(`Verify    : ${explorer}/transaction/${txHash}`);

  // CIP-26 draft only. Plutus policies can't prove ownership the way native-script entries do:
  // acceptance follows the cardano-token-registry trusted-key and human-verification process.
  const registryEntry = {
    subject: assetId,
    name: { value: TOKEN_NAME },
    description: { value: DESCRIPTION },
    ticker: { value: TOKEN_NAME },
    decimals: { value: DECIMALS },
    url: { value: WEBSITE },
    logo: {
      value: '<base64-encoded square transparent PNG of the official L4VA mark>',
    },
  };
  console.log('\n--- CIP-26 token registry entry (draft, no `policy` field for Plutus assets) ---');
  console.log(JSON.stringify(registryEntry, null, 2));
  console.log(
    'Sign with your chosen registry key and open the PR manually. Ownership is not verified automatically;' +
      ' follow https://github.com/cardano-foundation/cardano-token-registry#semantic-content-of-registry-entries'
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
