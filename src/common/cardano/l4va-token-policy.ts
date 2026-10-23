import { Constr, Data, mintingPolicyToId, type MintingPolicy } from '@lucid-evolution/lucid';

import {
  policyId as mainnetPolicyId,
  script as mainnetScript,
} from '@/scripts/cardano/deployments/mainnet-ac1e9156039f0c88d91fb17bbcd4e6bf7755e1c13546ab3388e5278f.json';
import {
  policyId as preprodPolicyId,
  script as preprodScript,
} from '@/scripts/cardano/deployments/preprod-de8a9ebc439b603e2898297464ca74e4e9a482cd4f060d10ba60c13d.json';

/** `Action.Burn` of the Aiken L4VA policy (src/scripts/cardano/l4va-token.plutus.json). */
export const L4VA_BURN_REDEEMER = Data.to(new Constr(1, []));

const DEPLOYED = [
  { policyId: mainnetPolicyId, script: mainnetScript },
  { policyId: preprodPolicyId, script: preprodScript },
];

/**
 * The deployed L4VA minting policy for `policyId`, or null when it is not one
 * of our deployments (e.g. an older test token). The policy lets any holder
 * burn L4VA they can spend.
 */
export function findL4vaPolicy(policyId: string): MintingPolicy | null {
  const deployed = DEPLOYED.find(d => d.policyId === policyId.toLowerCase());
  if (!deployed) return null;

  const policy: MintingPolicy = { type: 'PlutusV3', script: deployed.script };
  const actual = mintingPolicyToId(policy);
  if (actual !== deployed.policyId) {
    throw new Error(`L4VA policy script hashes to ${actual}, expected ${deployed.policyId}`);
  }
  return policy;
}
