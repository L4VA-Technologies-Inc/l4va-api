/**
 * Cross-checks Lucid parameter encoding against `aiken blueprint apply`.
 *
 *   npx ts-node src/scripts/cardano/l4va-policy.check.ts            # prints param CBOR + policy ids
 *   EXPECTED_BASE=<hash> EXPECTED_ENTERPRISE=<hash> npx ts-node ...  # asserts equality
 *
 * Feed the printed CBOR to `aiken blueprint apply` (seed first, then treasury), then
 * `aiken blueprint hash`. Aiken validates each argument against the blueprint schema.
 */

import { Data, credentialToAddress } from '@lucid-evolution/lucid';

import { addressToData, applyL4vaParams, seedToData, type SeedRef } from './l4va-policy';

const seed: SeedRef = {
  txHash: 'ef6ffddfe2206bb47bf5e1d1d79bbb2d702519a5d5b6b3f95aeeb080141ae877',
  outputIndex: 3,
};

const payment = { type: 'Key' as const, hash: 'aa'.repeat(28) };
const stake = { type: 'Key' as const, hash: 'bb'.repeat(28) };

const cases = {
  BASE: credentialToAddress('Preprod', payment, stake),
  ENTERPRISE: credentialToAddress('Preprod', payment),
};

let failed = false;
console.log(`seed param CBOR: ${Data.to(seedToData(seed))}`);
for (const [label, address] of Object.entries(cases)) {
  const { policyId } = applyL4vaParams(seed, address);
  console.log(`\n[${label}] treasury param CBOR: ${Data.to(addressToData(address))}`);
  console.log(`[${label}] policy id (Lucid): ${policyId}`);
  const expected = process.env[`EXPECTED_${label}`];
  if (expected) {
    const ok = expected === policyId;
    failed ||= !ok;
    console.log(`[${label}] aiken: ${expected} → ${ok ? 'MATCH' : 'MISMATCH'}`);
  }
}
process.exit(failed ? 1 : 0);
