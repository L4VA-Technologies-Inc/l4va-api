import { ResolvedVaultCreationSpec, VaultFieldSpec } from './spec.types';

export interface SanitizeResult {
  draft: Record<string, unknown>;
  /** `field: reason` pairs for values the model produced that were rejected. */
  rejected: string[];
}

function sanitizeValue(name: string, field: VaultFieldSpec, value: unknown, rejected: string[]): unknown | undefined {
  switch (field.type) {
    case 'boolean': {
      if (typeof value !== 'boolean') {
        rejected.push(`${name}: expected a boolean`);
        return undefined;
      }
      return value;
    }

    case 'number':
    case 'integer': {
      const numeric = typeof value === 'string' ? Number(value) : value;
      if (typeof numeric !== 'number' || !Number.isFinite(numeric)) {
        rejected.push(`${name}: expected a number`);
        return undefined;
      }
      if (field.type === 'integer' && !Number.isInteger(numeric)) {
        rejected.push(`${name}: must be an integer`);
        return undefined;
      }
      if (field.min !== undefined && numeric < field.min) {
        rejected.push(`${name}: below the minimum of ${field.min}`);
        return undefined;
      }
      if (field.max !== undefined && numeric > field.max) {
        rejected.push(`${name}: above the maximum of ${field.max}`);
        return undefined;
      }
      return numeric;
    }

    case 'enum': {
      if (typeof value !== 'string' || !field.values?.includes(value)) {
        rejected.push(`${name}: must be one of ${field.values?.join(', ')}`);
        return undefined;
      }
      return value;
    }

    case 'enumArray': {
      if (!Array.isArray(value)) {
        rejected.push(`${name}: expected an array`);
        return undefined;
      }
      const allowed = value.filter(
        (item): item is string => typeof item === 'string' && !!field.values?.includes(item)
      );
      if (allowed.length !== value.length) {
        rejected.push(`${name}: contained values outside the allowed list`);
      }
      return field.max !== undefined ? allowed.slice(0, field.max) : allowed;
    }

    default: {
      if (typeof value !== 'string') {
        rejected.push(`${name}: expected a string`);
        return undefined;
      }
      const trimmed = value.trim();
      if (field.minLength !== undefined && trimmed.length < field.minLength) {
        rejected.push(`${name}: shorter than ${field.minLength} characters`);
        return undefined;
      }
      if (field.maxLength !== undefined && trimmed.length > field.maxLength) {
        rejected.push(`${name}: longer than ${field.maxLength} characters`);
        return undefined;
      }
      if (field.pattern && !new RegExp(field.pattern).test(trimmed)) {
        rejected.push(`${name}: does not match ${field.pattern}`);
        return undefined;
      }
      return trimmed;
    }
  }
}

/**
 * Keep only fields the spec marks as AI-editable and whose value satisfies the spec bounds.
 * Anything else — unknown keys, whitelists, ids, out-of-range numbers — is dropped, so a model
 * that ignores its instructions cannot inject values into the vault draft.
 */
export function sanitizeVaultDraft(raw: unknown, spec: ResolvedVaultCreationSpec): SanitizeResult {
  const rejected: string[] = [];
  const draft: Record<string, unknown> = {};

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { draft, rejected: ['vaultDraft: expected an object'] };
  }

  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;

    const field = spec.fields[name];
    if (!field) {
      rejected.push(`${name}: not a vault field`);
      continue;
    }
    if (!field.aiEditable) {
      rejected.push(`${name}: cannot be set by the assistant`);
      continue;
    }

    const sanitized = sanitizeValue(name, field, value, rejected);
    if (sanitized !== undefined) {
      draft[name] = sanitized;
    }
  }

  return { draft, rejected };
}
