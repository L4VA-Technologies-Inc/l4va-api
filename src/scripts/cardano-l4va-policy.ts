/**
 * Canonical L4VA Cardano minting-policy definition.
 *
 * Both the mint and burn scripts derive the policy from here so they can never
 * drift — the policy ID is the hash of the script, so any difference produces a
 * DIFFERENT ASSET rather than an error you would notice.
 *
 * ── Fixed supply (decided 04.09.2026) ────────────────────────────────────────
 * Rob settled on a fixed Cardano supply after Artem raised that a mintable
 * policy could not guarantee no further L4VA is ever minted there:
 *
 *   Artem: "we would need to create a policy on cardano with minting/burning
 *           capability, and we cannot currently guarantee that we won't mint
 *           extra tokens on cardano"
 *   Rob:   "Ok then prob fixed supply on cardano"
 *
 * The policy is therefore time-locked:
 *
 *   all [ sig <adminKeyHash>, before <lockSlot> ]
 *
 * Before `lockSlot` the admin key can mint (and burn). After it, the script can
 * never validate again — no mint, no burn, by anyone, forever. That makes
 * "fixed supply" cryptographically true rather than a promise, which is exactly
 * the property investors are being asked to check.
 *
 * ── The tradeoff, stated plainly ─────────────────────────────────────────────
 * Cardano native scripts CANNOT distinguish minting from burning — a burn is a
 * negative mint, so a policy that allows one allows the other. Locking to
 * prevent minting therefore also prevents burning. `burn-cardano-l4va.ts` stops
 * working once the lock passes.
 *
 * That is accepted deliberately: a future Cardano→RH migration does not need a
 * Cardano burn. Tokens can be LOCKED in a script address while RH mints against
 * them under its 100M of headroom below MAX_SUPPLY, which reaches the same end
 * state without a mintable Cardano policy.
 *
 * If a genuine on-chain burn is ever required on the Cardano side, that needs a
 * Plutus policy that accepts only negative mints — a different design, and one
 * that must be decided BEFORE minting, since the policy ID is fixed at mint.
 *
 * ── Decimals ─────────────────────────────────────────────────────────────────
 * 6, NOT 18. Cardano native-asset quantities are int64 (max 9,223,372,036,854,
 * 775,807 ≈ 9.22e18). The previous value of 18 would have minted
 * 100,000,000 × 10^18 = 1e26, roughly 10.8 million times over the ledger limit —
 * the transaction could never have been submitted, on preprod or mainnet.
 *
 *   100,000,000 × 10^6 = 1e14  ✅ comfortably inside int64
 *
 * 6 also matches LayerZero's default OFT `sharedDecimals`, so bridging against
 * the 18-decimal EVM token needs no custom precision handling.
 */

import type { Native, Script } from '@lucid-evolution/core-types';
import { fromText } from '@lucid-evolution/core-utils';
import { getAddressDetails, mintingPolicyToId, scriptFromNative } from '@lucid-evolution/utils';

export type CardanoNetwork = 'Mainnet' | 'Preprod';

export const TOKEN_NAME = 'L4VA';
export const TICKER = 'L4VA';
export const DECIMALS = 6;
export const MAX_SUPPLY_TOKENS = 100_000_000n;

/** Raw on-chain quantity: 100,000,000 × 10^6 = 100,000,000,000,000. */
export const TOTAL_SUPPLY = MAX_SUPPLY_TOKENS * 10n ** BigInt(DECIMALS);

/** Cardano ledger cap on a single native-asset quantity (int64 max). */
export const INT64_MAX = 9_223_372_036_854_775_807n;

export interface L4VAPolicy {
  policy: Script;
  policyId: string;
  assetId: string;
  lockSlot: number;
  adminKeyHash: string;
}

/**
 * Build the time-locked policy.
 *
 * @param adminAddress Address whose payment key controls minting until the lock.
 * @param lockSlot     Absolute slot after which the policy can never validate.
 */
export function buildL4VAPolicy(adminAddress: string, lockSlot: number): L4VAPolicy {
  if (!Number.isInteger(lockSlot) || lockSlot <= 0) {
    throw new Error(`lockSlot must be a positive integer slot number (got: ${lockSlot})`);
  }

  const { paymentCredential } = getAddressDetails(adminAddress);
  if (!paymentCredential) {
    throw new Error('Cannot derive payment credential from ADMIN_ADDRESS');
  }

  const nativeScript: Native = {
    type: 'all',
    scripts: [
      { type: 'sig', keyHash: paymentCredential.hash },
      // "before" == invalidHereafter: the script only validates in transactions
      // whose validity interval ends before this slot. Past it, nothing passes.
      { type: 'before', slot: lockSlot },
    ],
  };

  const policy = scriptFromNative(nativeScript);
  const policyId = mintingPolicyToId(policy);

  return {
    policy,
    policyId,
    assetId: `${policyId}${fromText(TOKEN_NAME)}`,
    lockSlot,
    adminKeyHash: paymentCredential.hash,
  };
}

/** Guard against re-introducing the int64 overflow. */
export function assertSupplyFitsLedger(supply: bigint): void {
  if (supply > INT64_MAX) {
    throw new Error(
      `Supply ${supply} exceeds Cardano's int64 limit (${INT64_MAX}). ` +
        `Native-asset quantities are int64 — reduce DECIMALS. ` +
        `At ${MAX_SUPPLY_TOKENS} tokens the maximum workable value is 10 decimals.`
    );
  }
}

/** Read and validate the lock slot both scripts must agree on. */
export function requireLockSlot(): number {
  const raw = process.env.L4VA_POLICY_LOCK_SLOT;
  if (!raw) {
    throw new Error(
      'L4VA_POLICY_LOCK_SLOT not set.\n' +
        'The lock slot is part of the policy script, so the policy ID depends on it. ' +
        'Mint prints this value — record it and pass the SAME value to every later script, ' +
        'or you will derive a different (wrong) policy.'
    );
  }
  const slot = Number(raw);
  if (!Number.isInteger(slot) || slot <= 0) {
    throw new Error(`L4VA_POLICY_LOCK_SLOT must be a positive integer (got: ${raw})`);
  }
  return slot;
}
