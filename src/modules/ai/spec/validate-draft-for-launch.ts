import { sanitizeVaultDraft } from './sanitize-draft';
import { FieldCondition, ResolvedVaultCreationSpec } from './spec.types';

import { ChainType } from '@/types/vault.types';

/** A single reason the vault cannot be launched, in a shape the assistant can act on directly. */
export interface LaunchBlocker {
  /** Vault field the blocker is about (form field name). */
  field: string;
  /** Plain-English sentence the assistant can say to the user almost verbatim. */
  message: string;
  /**
   * Reserved UI action that resolves this blocker, if any:
   * - `choose_assets` — open the verified-collection picker
   * - `generate_image` / `upload_image` — the single vault image
   * A `null` action means the user has to resolve it in the manual vault form.
   */
  action: 'choose_assets' | 'generate_image' | 'upload_image' | null;
}

export interface LaunchValidationResult {
  ok: boolean;
  /**
   * Required fields that still have no usable value, in spec order. Kept for the completion-context
   * summary; `blockers` is the authoritative, user-facing list.
   */
  missingFields: string[];
  /** Human-readable bound / cross-field violations. */
  errors: string[];
  /** Every reason the launch is blocked — missing values and invalid values together, deduped. */
  blockers: LaunchBlocker[];
  /** The sanitized AI-editable part of the draft the check ran against. */
  draft: Record<string, unknown>;
}

/**
 * Chain-specific identifier formats. These mirror, exactly, the regexes the client yup schema
 * (`l4va-client/src/components/vaults/constants/vaults.constants.js`) enforces on each row before
 * `useLaunchVault` will submit — see the parity tests in `validate-draft-for-launch.spec.ts`.
 */
const CARDANO_POLICY_ID = /^[0-9a-fA-F]{56}$/;
const EVM_CONTRACT_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CARDANO_PREPROD_WALLET = /^addr_test1[a-z0-9]{20,}$/i;
const CARDANO_MAINNET_WALLET = /^addr1[a-z0-9]{20,}$/i;

function isEvmChain(spec: ResolvedVaultCreationSpec): boolean {
  return spec.chain === ChainType.robinhood;
}

function assetIdMatcher(spec: ResolvedVaultCreationSpec): RegExp {
  return isEvmChain(spec) ? EVM_CONTRACT_ADDRESS : CARDANO_POLICY_ID;
}

function walletMatcher(spec: ResolvedVaultCreationSpec): RegExp {
  if (isEvmChain(spec)) return EVM_CONTRACT_ADDRESS;
  return spec.network === 'mainnet' ? CARDANO_MAINNET_WALLET : CARDANO_PREPROD_WALLET;
}

function asRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row));
}

/**
 * Number of asset-whitelist rows that would survive the client's `assetWhitelistItemSchema`: a
 * `policyId` in the chain's identifier format, and — on Cardano — a client-side `isVerified === true`
 * flag (EVM contracts skip the Cardano verification system, exactly as the yup schema does).
 */
export function countValidAssetRows(value: unknown, spec: ResolvedVaultCreationSpec): number {
  const matcher = assetIdMatcher(spec);
  const requireVerified = !isEvmChain(spec);
  return asRows(value).filter(row => {
    const policyId = typeof row.policyId === 'string' ? row.policyId.trim() : '';
    if (!matcher.test(policyId)) return false;
    return requireVerified ? row.isVerified === true : true;
  }).length;
}

/** Number of participant-whitelist rows with a `walletAddress` in the chain's address format. */
export function countValidWalletRows(value: unknown, spec: ResolvedVaultCreationSpec): number {
  const matcher = walletMatcher(spec);
  return asRows(value).filter(row => {
    const address = typeof row.walletAddress === 'string' ? row.walletAddress.trim() : '';
    return address.length >= 20 && matcher.test(address);
  }).length;
}

/** A scalar/enum value counts as "filled in" only when it carries actual content. */
function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function matches(conditions: readonly FieldCondition[] | undefined, view: Record<string, unknown>): boolean {
  return !!conditions?.length && conditions.every(condition => view[condition.field] === condition.equals);
}

function isApplicable(conditions: readonly FieldCondition[] | undefined, view: Record<string, unknown>): boolean {
  return !conditions?.length || !conditions.some(condition => view[condition.field] === condition.equals);
}

/**
 * Fields whose "is it filled in?" check is not a simple presence test — they need row-level
 * validation identical to the client yup schema — so the generic required-field loop skips them and
 * they are checked explicitly below.
 */
const EXPLICITLY_CHECKED = new Set([
  'assetsWhitelist',
  'contributorWhitelist',
  'acquirerWhitelist',
  'vaultImage',
  'ftTokenImg',
]);

/**
 * Server-side launch gate for an AI-built draft.
 *
 * ## Why this exists
 *
 * The real launch validators are the client yup `vaultSchema` (run by `useLaunchVault` before the
 * wallet prompt) and the `CreateVault` DTO on the creation endpoint. This function is a faithful
 * server-side mirror of every rule those two enforce that can be checked *before* wallet signing,
 * so the `launch_vault` tool can guarantee its invariant:
 *
 *   if it returns a `launch_vault` confirmation action, the same draft already passes yup —
 *   the confirmation can never open and immediately fail on a missing form field.
 *
 * The mirror (not shared code) is deliberate: the yup schema depends on `localStorage` /
 * `import.meta.env` and cannot run under Node. Parity is proven instead by the fixture tests in
 * `validate-draft-for-launch.spec.ts`, which must be updated in the same PR as the yup schema.
 */
export function validateVaultDraftForLaunch(
  rawDraft: unknown,
  spec: ResolvedVaultCreationSpec
): LaunchValidationResult {
  const source =
    rawDraft && typeof rawDraft === 'object' && !Array.isArray(rawDraft) ? (rawDraft as Record<string, unknown>) : {};

  // AI-editable values go through the same sanitizer as every other turn; fields the assistant may
  // not touch (images, whitelists) are read straight from the client draft.
  const { draft, rejected } = sanitizeVaultDraft(
    Object.fromEntries(
      // A blank value means "not decided yet", not "invalid" — it is reported as missing instead.
      Object.entries(source).filter(([name, value]) => spec.fields[name]?.aiEditable && hasValue(value))
    ),
    spec
  );

  // Values the sanitizer rejected are deliberately absent from the view: a bad value must not be
  // able to satisfy a requirement or flip a cross-field rule.
  const view: Record<string, unknown> = {
    ...Object.fromEntries(Object.entries(source).filter(([name]) => !spec.fields[name]?.aiEditable)),
    ...draft,
  };

  const missingFields: string[] = [];
  const errors: string[] = [...rejected];
  const blockers: LaunchBlocker[] = [];
  const blockedFields = new Set<string>();

  const addBlocker = (blocker: LaunchBlocker): void => {
    if (blockedFields.has(blocker.field)) return;
    blockedFields.add(blocker.field);
    blockers.push(blocker);
  };

  // --- Generic required-field presence (scalars / enums only) ---------------
  for (const [name, field] of Object.entries(spec.fields)) {
    if (EXPLICITLY_CHECKED.has(name)) continue;
    if (!isApplicable(field.notApplicableIf, view)) continue;

    const required = field.required === true || matches(field.requiredIf, view);
    if (required && !hasValue(view[name])) {
      missingFields.push(name);
      addBlocker({ field: name, message: `${humanize(name)} is required.`, action: null });
    }
  }

  // --- The single vault image (vaultImage + ftTokenImg move together) ------
  const hasImage = hasValue(view.vaultImage) && hasValue(view.ftTokenImg);
  if (!hasImage) {
    if (!hasValue(view.vaultImage)) missingFields.push('vaultImage');
    if (!hasValue(view.ftTokenImg)) missingFields.push('ftTokenImg');
    addBlocker({
      field: 'vaultImage',
      message: 'The vault still needs an image.',
      action: 'generate_image',
    });
  }

  // --- Asset whitelist (not applicable to acquire-only vaults) -------------
  if (view.isAcquireOnly !== true) {
    const validAssets = countValidAssetRows(view.assetsWhitelist, spec);
    if (validAssets < 1) {
      missingFields.push('assetsWhitelist');
      addBlocker({
        field: 'assetsWhitelist',
        message: 'At least one verified asset collection must be selected.',
        action: 'choose_assets',
      });
    } else if (validAssets > 10) {
      errors.push('assetsWhitelist: a maximum of 10 asset collections can be whitelisted');
      addBlocker({
        field: 'assetsWhitelist',
        message: 'A vault can whitelist at most 10 asset collections.',
        action: 'choose_assets',
      });
    }
  }

  // --- Participant whitelists ---------------------------------------------
  const validContributors = countValidWalletRows(view.contributorWhitelist, spec);
  const validAcquirers = countValidWalletRows(view.acquirerWhitelist, spec);

  if (view.privacy === 'private') {
    if (view.valueMethod === 'lbe' && validContributors < 1) {
      missingFields.push('contributorWhitelist');
      addBlocker({
        field: 'contributorWhitelist',
        message: 'A private vault needs a contributor whitelist — add it in the vault form.',
        action: null,
      });
    }
    if (validAcquirers < 1) {
      missingFields.push('acquirerWhitelist');
      addBlocker({
        field: 'acquirerWhitelist',
        message: 'A private vault needs an acquirer whitelist — add it in the vault form.',
        action: null,
      });
    }
  } else if (view.privacy === 'semi-private' && validContributors + validAcquirers < 1) {
    missingFields.push('contributorWhitelist');
    addBlocker({
      field: 'contributorWhitelist',
      message:
        'A semi-private vault needs at least one contributor or acquirer whitelisted — add it in the vault form.',
      action: null,
    });
  }

  // --- Cross-field rules the individual field bounds cannot express -------
  if (
    view.tokensForAcquires === 0 &&
    hasValue(view.liquidityPoolContribution) &&
    view.liquidityPoolContribution !== 0
  ) {
    pushError(errors, blockers, blockedFields, {
      field: 'liquidityPoolContribution',
      message: 'Liquidity pool contribution must be 0 when no tokens go to acquirers.',
      action: null,
    });
  }
  if (view.isAcquireOnly === true && hasValue(view.tokensForAcquires) && view.tokensForAcquires !== 100) {
    pushError(errors, blockers, blockedFields, {
      field: 'tokensForAcquires',
      message: 'An acquire-only vault must give 100% of tokens to acquirers.',
      action: null,
    });
  }
  if (view.valueMethod === 'fixed' && view.privacy !== 'private') {
    pushError(errors, blockers, blockedFields, {
      field: 'valueMethod',
      message: 'Fixed valuation is only available for private vaults.',
      action: null,
    });
  }
  if (isEvmChain(spec) && hasValue(view.privacy) && view.privacy !== 'public') {
    pushError(errors, blockers, blockedFields, {
      field: 'privacy',
      message: 'Robinhood Chain vaults are always public.',
      action: null,
    });
  }
  if (
    view.privacy === 'private' &&
    view.valueMethod === 'fixed' &&
    hasValue(view.valuationAmount) &&
    Number(view.valuationAmount) <= 0
  ) {
    pushError(errors, blockers, blockedFields, {
      field: 'valuationAmount',
      message: 'The fixed valuation amount must be a positive number.',
      action: null,
    });
  }

  return {
    ok: blockers.length === 0,
    missingFields,
    errors,
    blockers,
    draft,
  };
}

function pushError(
  errors: string[],
  blockers: LaunchBlocker[],
  blockedFields: Set<string>,
  blocker: LaunchBlocker
): void {
  errors.push(`${blocker.field}: ${blocker.message}`);
  if (blockedFields.has(blocker.field)) return;
  blockedFields.add(blocker.field);
  blockers.push(blocker);
}

/** "assetsWhitelist" -> "Assets whitelist" for the generic required-field message. */
function humanize(field: string): string {
  const spaced = field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}
