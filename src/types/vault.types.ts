// step 1
export enum VaultType {
  single = 'single',
  multi = 'multi',
  ctn = 'ctn',
  cnt = 'cnt',
}

export enum VaultPrivacy {
  // Represent an enum setup by L4VA (0: PRIVATE | 1: PUBLIC | 2: SEMI_PRIVATE) in SC
  private = 'private',
  public = 'public',
  semiPrivate = 'semi-private',
}

// step 2
export enum ValueMethod {
  // Enum 0: 'FIXED' 1: 'LBE' in SC
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

export interface ApplyParamsResult {
  addresses: {
    [scriptHash: string]: {
      hex: string;
      bech32: string;
    };
  };
  preloadedScript: {
    type: string;
    blueprint: {
      preamble: {
        id: number;
        title: string;
        license: string;
        version: string;
        clientId: string;
        compiler: {
          name: string;
          version: string;
        };
        createdAt: string;
        updatedAt: string;
        description: string;
        plutusVersion: string;
      };
      validators: Array<{
        ref: string;
        hash: string;
        datum?: {
          title: string;
          schema: {
            $ref: string;
          };
        };
        title: string;
        redeemer?: {
          title?: string;
          schema: any;
        };
        description: string | null;
        compiledCode: string;
        parameters?: any;
      }>;
    };
    validatorRefs?: {
      [hash: string]: {
        index: number;
        txHash: string;
      };
    };
  };
  definitions?: Record<string, any>;
}
