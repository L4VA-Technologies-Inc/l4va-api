
// step 1
export enum VaultType {
  single = 'single',
  multi = 'multi',
  ctn = 'ctn'
}

export enum VaultPrivacy {
  private = 'private',
  public = 'public',
  semiPrivate = 'semi-private'
}

// step 2
export enum ValuationType {
  lbe ='lbe'
}
export enum ContributionWindowType {
  custom = 'custom',
  uponVaultLunch = 'upon-vault-lunch'
}

// step 3

export enum InvestmentWindowType {
  custom = 'custom',
  uponAssetWindowClosing = 'upon-asset-window-closing'
}

// step 4
export enum TerminationType {
  dao = 'dao',
  programmed ='programmed',
}


export enum VaultStatus {
  draft = 'draft',
  published = 'published',
  contribution = 'contribution',
  investment = 'investment',
  locked = 'locked'
}
