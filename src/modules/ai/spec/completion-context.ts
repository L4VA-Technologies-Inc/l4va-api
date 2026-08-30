import {
  countValidAssetRows,
  countValidWalletRows,
  LaunchBlocker,
  validateVaultDraftForLaunch,
} from './validate-draft-for-launch';

import { ResolvedVaultCreationSpec } from '@/modules/ai/spec/spec.types';

/**
 * Plain-English names for the requirements only the user can satisfy. Both image fields map to one
 * phrase because L4VA uses a single image for the vault and its token.
 */
export const USER_SUPPLIED_NEEDS: Record<string, string> = {
  assetsWhitelist: 'the real asset collection to allow',
  vaultImage: 'a vault image',
  ftTokenImg: 'a vault image',
  contributorWhitelist: 'the contributor whitelist',
  acquirerWhitelist: 'the acquirer whitelist',
};

/** Distinct, user-facing descriptions of what the user still has to provide. */
export function describeUserNeeds(missingFields: string[]): string[] {
  return [...new Set(missingFields.map(field => USER_SUPPLIED_NEEDS[field]).filter(Boolean))];
}

/**
 * What the assistant needs in order to know whether the vault can launch.
 *
 * Split by who can act: the model fixes `missingAiFields` itself in the next draft, while
 * `missingUserControlledFields` can only be resolved through the UI.
 */
export interface VaultCompletionContext {
  isLaunchable: boolean;
  /** Requirements the user must satisfy, in plain English. */
  needsFromUser: string[];
  missingUserControlledFields: string[];
  missingAiFields: string[];
  invalidValues: string[];
  /** The exact, ordered launch blockers — the same list `launch_vault` would return. */
  blockers: LaunchBlocker[];
  hasVaultImage: boolean;
  assetWhitelistCount: number;
  hasContributorWhitelist: boolean;
  hasAcquirerWhitelist: boolean;
}

/**
 * Derived from the same launch validation the `launch_vault` tool runs, against the *whole* vault
 * state — including the fields the assistant may not edit. Without this the model cannot see that
 * an image or a collection is missing, and stops mid-workflow waiting to be asked.
 */
export function buildVaultCompletionContext(
  rawDraft: unknown,
  spec: ResolvedVaultCreationSpec
): VaultCompletionContext {
  const validation = validateVaultDraftForLaunch(rawDraft, spec);
  const draft = rawDraft && typeof rawDraft === 'object' ? (rawDraft as Record<string, unknown>) : {};

  const missingUserControlledFields = validation.missingFields.filter(field => !spec.fields[field]?.aiEditable);
  const missingAiFields = validation.missingFields.filter(field => spec.fields[field]?.aiEditable);

  return {
    isLaunchable: validation.ok,
    needsFromUser: describeUserNeeds(missingUserControlledFields),
    missingUserControlledFields,
    missingAiFields,
    invalidValues: validation.errors,
    blockers: validation.blockers,
    hasVaultImage:
      typeof draft.vaultImage === 'string' &&
      draft.vaultImage.trim().length > 0 &&
      typeof draft.ftTokenImg === 'string' &&
      draft.ftTokenImg.trim().length > 0,
    // Counted the same way the launch gate and the client yup schema count them: only rows that
    // would actually pass validation, never the blank scaffold row the form starts with.
    assetWhitelistCount: countValidAssetRows(draft.assetsWhitelist, spec),
    hasContributorWhitelist: countValidWalletRows(draft.contributorWhitelist, spec) > 0,
    hasAcquirerWhitelist: countValidWalletRows(draft.acquirerWhitelist, spec) > 0,
  };
}
