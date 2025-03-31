
// step 1
export enum VaultType {
  single = 'single',
  multi = 'multi',
  ctn = 'ctn',
  cnt = 'cnt'
}

export enum VaultPrivacy {
  private = 'private',
  public = 'public',
  semiPrivate = 'semi-private'
}

// step 2
export enum ValuationType {
  lbe ='lbe',
  fixed = 'fixed'
}
export enum ContributionWindowType {
  custom = 'custom',
  uponVaultLaunch = 'upon-vault-launch'
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
  locked = 'locked',
  governance = 'governance'
}
