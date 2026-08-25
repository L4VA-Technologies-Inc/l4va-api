import { ResolvedVaultCreationSpec, SpecChain, SpecNetwork, VaultFieldSpec } from './spec.types';
import { VAULT_CREATION_SPEC } from './vault-creation-spec';

import { ChainType } from '@/types/vault.types';

export function isSpecChain(value: unknown): value is SpecChain {
  return value === ChainType.cardano || value === ChainType.robinhood;
}

export function isSpecNetwork(value: unknown): value is SpecNetwork {
  return value === 'preprod' || value === 'mainnet';
}

/** Merge base fields with the network overrides and then the chain profile overrides. */
export function resolveVaultCreationSpec(chain: SpecChain, network: SpecNetwork): ResolvedVaultCreationSpec {
  const profile = VAULT_CREATION_SPEC.chainProfiles[chain];
  const networkOverrides = VAULT_CREATION_SPEC.networkOverrides[network];

  const fields: Record<string, VaultFieldSpec> = {};
  for (const [name, field] of Object.entries(VAULT_CREATION_SPEC.fields)) {
    fields[name] = {
      ...field,
      ...(networkOverrides[name] ?? {}),
      ...(profile.fields?.[name] ?? {}),
    };
  }

  return {
    version: VAULT_CREATION_SPEC.version,
    chain,
    network,
    currency: profile.currency,
    assetIdentifier: profile.assetIdentifier,
    rules: [...VAULT_CREATION_SPEC.rules, ...(profile.rules ?? [])],
    fields,
  };
}

/** Field names the model is allowed to emit. Everything else is dropped from its output. */
export function aiEditableFieldNames(spec: ResolvedVaultCreationSpec): string[] {
  return Object.entries(spec.fields)
    .filter(([, field]) => field.aiEditable)
    .map(([name]) => name);
}
