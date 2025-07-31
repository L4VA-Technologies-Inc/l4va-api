// step 1
export enum VaultType {
  single = 'single',
  multi = 'multi',
  ctn = 'ctn',
  cnt = 'cnt',
}

export enum VaultPrivacy {
  private = 'private',
  public = 'public',
  semiPrivate = 'semi-private',
}

// Smart contract acquire multiplier type
export interface AcquireMultiplier {
  policyId: string;
  assetName?: string | null; // None in smart contract
  multiplier: number;
}

// step 2
export enum ValueMethod {
  lbe = 'lbe',
  fixed = 'fixed',
}
export enum ContributionWindowType {
  custom = 'custom',
  uponVaultLaunch = 'upon-vault-launch',
}

// step 3

export enum InvestmentWindowType {
  custom = 'custom',
  uponAssetWindowClosing = 'upon-asset-window-closing',
}

// step 4
export enum TerminationType {
  dao = 'dao',
  programmed = 'programmed',
}

export enum VaultStatus {
  draft = 'draft',
  created = 'created',
  published = 'published',
  contribution = 'contribution',
  acquire = 'acquire',
  investment = 'investment',
  locked = 'locked',
  failed = 'failed',
}

// Mapping for smart contract vault status
export enum SmartContractVaultStatus {
  PENDING = 0,
  OPEN = 1,
  SUCCESSFUL = 2,
  CANCELLED = 3,
}
