import { ChainType } from '@/types/vault.types';

export type SpecChain = ChainType.cardano | ChainType.robinhood;
export type SpecNetwork = 'preprod' | 'mainnet';

export type VaultFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'enumArray';

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

export interface VaultCreationSpec {
  /** Bump whenever fields or bounds change so clients can detect a stale cache. */
  version: string;
  rules: string[];
  fields: Record<string, VaultFieldSpec>;
  networkOverrides: Record<SpecNetwork, Record<string, VaultFieldOverride>>;
  chainProfiles: Record<SpecChain, ChainProfile>;
}

export interface ResolvedVaultCreationSpec {
  version: string;
  chain: SpecChain;
  network: SpecNetwork;
  currency: string;
  assetIdentifier: string;
  rules: string[];
  fields: Record<string, VaultFieldSpec>;
}
