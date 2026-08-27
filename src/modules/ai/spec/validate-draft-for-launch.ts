import { sanitizeVaultDraft } from './sanitize-draft';
import { FieldCondition, ResolvedVaultCreationSpec } from './spec.types';

import { ChainType } from '@/types/vault.types';

export interface LaunchValidationResult {
  ok: boolean;
  /** Required fields that still have no usable value, in spec order. */
  missingFields: string[];
  /** Values that are present but violate a bound or a cross-field rule. */
  errors: string[];
  /** The sanitized AI-editable part of the draft the check ran against. */
  draft: Record<string, unknown>;
}

/** A value counts as "filled in" only when it carries actual content. */
function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    // Whitelist rows start out as empty objects in the form state, so an array of blanks is empty.
    return value.some(item =>
      item && typeof item === 'object' ? Object.values(item as Record<string, unknown>).some(hasValue) : hasValue(item)
    );
  }
  return true;
}

function matches(conditions: readonly FieldCondition[] | undefined, view: Record<string, unknown>): boolean {
  return !!conditions?.length && conditions.every(condition => view[condition.field] === condition.equals);
}

function isApplicable(conditions: readonly FieldCondition[] | undefined, view: Record<string, unknown>): boolean {
  return !conditions?.length || !conditions.some(condition => view[condition.field] === condition.equals);
}

/**
 * Server-side launch gate for an AI-built draft.
 *
 * Runs against the same spec that constrains what the assistant may propose, so requirements,
 * bounds and cross-field rules live in one place. This is a pre-flight check, not the authority:
 * the form re-validates with the live yup schema and the vault-creation API validates again before
 * anything is signed. Its job is to stop the assistant from offering a launch that cannot succeed.
 */
export function validateVaultDraftForLaunch(
  rawDraft: unknown,
  spec: ResolvedVaultCreationSpec
): LaunchValidationResult {
  const source =
    rawDraft && typeof rawDraft === 'object' && !Array.isArray(rawDraft) ? (rawDraft as Record<string, unknown>) : {};

  // AI-editable values go through the same sanitizer as every other turn; fields the assistant may
  // not touch (images, whitelists) are read straight from the client draft and only checked for
  // presence — their contents are validated by the form and the creation API.
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

  for (const [name, field] of Object.entries(spec.fields)) {
    if (!isApplicable(field.notApplicableIf, view)) continue;

    const required = field.required === true || matches(field.requiredIf, view);
    if (required && !hasValue(view[name])) {
      missingFields.push(name);
    }
  }

  // Cross-field rules the individual field bounds cannot express (mirrors spec.rules).
  if (
    view.tokensForAcquires === 0 &&
    hasValue(view.liquidityPoolContribution) &&
    view.liquidityPoolContribution !== 0
  ) {
    errors.push('liquidityPoolContribution: must be 0 when tokensForAcquires is 0');
  }
  if (view.isAcquireOnly === true && hasValue(view.tokensForAcquires) && view.tokensForAcquires !== 100) {
    errors.push('tokensForAcquires: must be 100 for an acquire-only vault');
  }
  if (view.valueMethod === 'fixed' && view.privacy !== 'private') {
    errors.push('valueMethod: "fixed" is only available for private vaults');
  }
  if (spec.chain === ChainType.robinhood && hasValue(view.privacy) && view.privacy !== 'public') {
    errors.push('privacy: Robinhood Chain vaults are always public');
  }
  if (view.privacy === 'semi-private' && !hasValue(view.contributorWhitelist) && !hasValue(view.acquirerWhitelist)) {
    errors.push('contributorWhitelist: a semi-private vault needs a contributor or acquirer whitelist');
  }

  return {
    ok: missingFields.length === 0 && errors.length === 0,
    missingFields,
    errors,
    draft,
  };
}
