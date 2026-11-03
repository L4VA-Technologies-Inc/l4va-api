import { ResolvedVaultCreationSpec, SpecChain, SpecNetwork, VaultFieldOverride, VaultFieldSpec } from './spec.types';
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
  runtimeOverrides: Record<string, VaultFieldOverride> = {}
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
    };
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
    .filter(([, field]) => field.aiEditable)
    .map(([name]) => name);
}
