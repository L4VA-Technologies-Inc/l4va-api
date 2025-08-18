import { ValueMethod, VaultPrivacy } from '@/types/vault.types';

export const vault_sc_privacy: Record<VaultPrivacy, number> = {
  private: 0,
  public: 1,
  'semi-private': 2,
};

export const valuation_sc_type: Record<ValueMethod, number> = {
  fixed: 0,
  lbe: 1,
};
