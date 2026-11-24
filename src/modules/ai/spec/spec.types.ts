import { VaultArchetype } from '@/types/index-vault.types';
import { ChainType } from '@/types/vault.types';

export type SpecChain = ChainType.cardano | ChainType.robinhood;
export type SpecNetwork = 'preprod' | 'mainnet';

export type VaultFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'enumArray';

/** Machine-readable counterpart of `requiredWhen`, evaluated by the launch validator. */
export interface FieldCondition {
  field: string;
  equals: string | number | boolean;
}

export interface VaultFieldSpec {
  type: VaultFieldType;
  /** Create-vault wizard step the field belongs to. */
  step: 1 | 2 | 3 | 4;
  description: string;
  /** `false` means the model must never emit this field (images, whitelists, ids). */
  aiEditable: boolean;
  required?: boolean;
  /** Human-readable condition rendered into the prompt when the field is conditionally required. */
  requiredWhen?: string;
  /** Field is required only when every condition holds (AND). Machine-readable `requiredWhen`. */
  requiredIf?: readonly FieldCondition[];
  /** Field is not part of this vault at all when any condition holds (OR) — never reported missing. */
  notApplicableIf?: readonly FieldCondition[];
  unit?: string;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  values?: readonly string[];
  default?: string | number | boolean | null;
}

export type VaultFieldOverride = Partial<VaultFieldSpec>;

export interface ChainProfile {
  currency: string;
  assetIdentifier: string;
  fields?: Record<string, VaultFieldOverride>;
  rules?: string[];
}

/**
 * What changes when the vault is of a given archetype. An index-weighted vault
 * raises native only and buys a basket, so several fields it shares with a
 * standard vault are fixed rather than chosen.
 */
export interface ArchetypeProfile {
  /** One line naming the product, rendered into the prompt's context block. */
  summary: string;
  fields?: Record<string, VaultFieldOverride>;
  rules?: string[];
}

export interface VaultCreationSpec {
  /** Bump whenever fields or bounds change so clients can detect a stale cache. */
  version: string;
  rules: string[];
  fields: Record<string, VaultFieldSpec>;
  networkOverrides: Record<SpecNetwork, Record<string, VaultFieldOverride>>;
  chainProfiles: Record<SpecChain, ChainProfile>;
  archetypeProfiles: Record<VaultArchetype, ArchetypeProfile>;
}

export interface ResolvedVaultCreationSpec {
  version: string;
  chain: SpecChain;
  network: SpecNetwork;
  /** The only vault type this chain currently offers; the assistant never picks it. */
  archetype: VaultArchetype;
  archetypeSummary: string;
  currency: string;
  assetIdentifier: string;
  rules: string[];
  fields: Record<string, VaultFieldSpec>;
}
