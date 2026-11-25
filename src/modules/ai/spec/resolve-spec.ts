import {
  ResolvedVaultCreationSpec,
  SpecChain,
  SpecNetwork,
  VaultFieldOverride,
  VaultFieldSpec,
  VaultSpecOverrides,
} from './spec.types';
import { VAULT_CREATION_SPEC } from './vault-creation-spec';

import { VaultArchetype } from '@/types/index-vault.types';
import { ChainType } from '@/types/vault.types';

export function isSpecChain(value: unknown): value is SpecChain {
  return value === ChainType.cardano || value === ChainType.robinhood;
}

export function isSpecNetwork(value: unknown): value is SpecNetwork {
  return value === 'preprod' || value === 'mainnet';
}

/**
 * Merge base fields with the network overrides, then the chain profile, then the
 * archetype the chain is currently offering. The archetype comes last because it
 * describes a different product, not a variation of the chain's defaults.
 * `runtimeOverrides` (env-driven bounds, e.g. staging's short phase minimums) win over all of them.
 */
export function resolveVaultCreationSpec(
  chain: SpecChain,
  network: SpecNetwork,
  archetype: VaultArchetype = VaultArchetype.standard,
  runtimeOverrides: Record<string, VaultFieldOverride> = {},
  configOverrides: VaultSpecOverrides = {}
): ResolvedVaultCreationSpec {
  const profile = VAULT_CREATION_SPEC.chainProfiles[chain];
  const networkOverrides = VAULT_CREATION_SPEC.networkOverrides[network];
  const archetypeProfile = VAULT_CREATION_SPEC.archetypeProfiles[archetype];

  const fields: Record<string, VaultFieldSpec> = {};
  for (const [name, field] of Object.entries(VAULT_CREATION_SPEC.fields)) {
    fields[name] = {
      ...field,
      ...(networkOverrides[name] ?? {}),
      ...(profile.fields?.[name] ?? {}),
      ...(archetypeProfile.fields?.[name] ?? {}),
      ...(runtimeOverrides[name] ?? {}),
      ...(configOverrides.all?.[name] ?? {}),
      ...(configOverrides[chain]?.[name] ?? {}),
    };
    const resolved = fields[name];
    // A config-added condition still needs prompt text.
    if (resolved.requiredIf?.length && !resolved.requiredWhen) {
      resolved.requiredWhen = resolved.requiredIf.map(c => `${c.field} is ${JSON.stringify(c.equals)}`).join(' and ');
    }
    if (resolved.disabled) {
      resolved.required = false;
      resolved.requiredIf = undefined;
      resolved.requiredWhen = undefined;
      resolved.aiEditable = false;
    }
    // A raised minimum must not leave the default below it.
    const { min, default: fallback } = fields[name];
    if (typeof min === 'number' && typeof fallback === 'number' && fallback < min) {
      fields[name].default = min;
    }
  }

  return {
    version: VAULT_CREATION_SPEC.version,
    chain,
    network,
    archetype,
    archetypeSummary: archetypeProfile.summary,
    currency: profile.currency,
    assetIdentifier: profile.assetIdentifier,
    rules: [...VAULT_CREATION_SPEC.rules, ...(profile.rules ?? []), ...(archetypeProfile.rules ?? [])],
    fields,
  };
}

/** Field names the model is allowed to emit. Everything else is dropped from its output. */
export function aiEditableFieldNames(spec: ResolvedVaultCreationSpec): string[] {
  return Object.entries(spec.fields)
    .filter(([, field]) => field.aiEditable && !field.disabled)
    .map(([name]) => name);
}

/** The system settings the vault creation spec takes its runtime bounds from. */
export interface VaultSpecSettings {
  specNetwork: SpecNetwork;
  minContributionDuration: number;
  maxContributionDuration: number;
  minAcquireWindowDuration: number;
  maxAcquireWindowDuration: number;
  /** Set only when the min is overridden by env (staging): the form and AI then start at it. */
  defaultAcquireWindowDuration?: number | null;
  minAcquireThresholdEth: number;
  maxAcquireThresholdEth: number;
  vaultArchetypesEnabled(chain: ChainType): VaultArchetype[];
  /** Config overrides (system settings, then env); optional so plain settings objects still work. */
  vaultSpecOverrides?: VaultSpecOverrides;
}

/**
 * The one resolved spec every consumer uses: the AI assistant, `GET /ai/vault-creation-spec`
 * (which the client form validates against) and `createVault`. System settings (and the env
 * vars behind them, e.g. MIN_CONTRIBUTION_DURATION_MS) override the static spec here, so a
 * changed setting reaches all three at once.
 */
export function resolveVaultCreationSpecFromSettings(
  settings: VaultSpecSettings,
  chain: SpecChain,
  network: SpecNetwork = settings.specNetwork,
  archetype?: VaultArchetype
): ResolvedVaultCreationSpec {
  const resolvedArchetype = archetype ?? settings.vaultArchetypesEnabled(chain)[0] ?? VaultArchetype.standard;
  const overrides: Record<string, VaultFieldOverride> = {
    contributionDuration: { min: settings.minContributionDuration, max: settings.maxContributionDuration },
    acquireWindowDuration: {
      min: settings.minAcquireWindowDuration,
      max: settings.maxAcquireWindowDuration,
      ...(settings.defaultAcquireWindowDuration ? { default: settings.defaultAcquireWindowDuration } : {}),
    },
  };
  if (chain === ChainType.robinhood) {
    overrides.minAcquireThreshold = { min: settings.minAcquireThresholdEth, max: settings.maxAcquireThresholdEth };
  }
  return resolveVaultCreationSpec(chain, network, resolvedArchetype, overrides, settings.vaultSpecOverrides ?? {});
}

/** True when the spec makes `name` required for these values (`required`, or every `requiredIf` holds). */
export function isSpecFieldRequired(field: VaultFieldSpec | undefined, values: Record<string, unknown>): boolean {
  if (!field || field.disabled) return false;
  if (field.required === true) return true;
  return !!field.requiredIf?.length && field.requiredIf.every(c => values[c.field] === c.equals);
}

export interface SpecBoundsViolation {
  field: string;
  message: string;
}

/**
 * Checks numeric fields against the resolved spec's min/max. `fields` maps a spec field to its
 * label; a field whose value is absent is skipped (required-ness is checked elsewhere).
 */
export function findSpecBoundsViolations(
  spec: ResolvedVaultCreationSpec,
  values: Record<string, unknown>,
  fields: Record<string, string>
): SpecBoundsViolation[] {
  const violations: SpecBoundsViolation[] = [];
  for (const [field, label] of Object.entries(fields)) {
    const raw = values[field];
    if (raw === null || raw === undefined || raw === '') continue;
    const value = Number(raw);
    const { min, max, unit } = spec.fields[field] ?? {};
    const hasMin = typeof min === 'number';
    const hasMax = typeof max === 'number';
    if (Number.isFinite(value) && (!hasMin || value >= min) && (!hasMax || value <= max)) continue;
    const fmt = (v: number): string => formatSpecBound(v, unit);
    const message = !Number.isFinite(value)
      ? `${label} must be a number`
      : hasMin && hasMax
        ? `${label} must be between ${fmt(min)} and ${fmt(max)}`
        : hasMin
          ? `${label} must be at least ${fmt(min)}`
          : `${label} cannot exceed ${fmt(max)}`;
    violations.push({ field, message });
  }
  return violations;
}

function formatSpecBound(value: number, unit?: string): string {
  if (unit === 'ms') {
    if (value % 86_400_000 === 0) return `${value / 86_400_000} day(s)`;
    if (value % 3_600_000 === 0) return `${value / 3_600_000} hour(s)`;
    return `${Math.round(value / 60_000)} minute(s)`;
  }
  if (unit === '%') return `${value}%`;
  return unit ? `${value.toLocaleString('en-US')} ${unit}` : String(value);
}
