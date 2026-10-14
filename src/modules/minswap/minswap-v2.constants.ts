/**
 * Minswap DEX V2 on-chain constants.
 * Ported from the official SDK (https://github.com/minswap/sdk, src/types/constants.ts → DexV2Constant).
 * Testnet values are Preprod.
 */

export type MinswapV2Config = {
  /** Policy of factory/pool authen assets and LP tokens (same as the authen minting policy). */
  lpPolicyId: string;
  factoryAsset: string;
  poolAuthenAsset: string;
  factoryScriptHashBech32: string;
  factoryAddress: string;
  poolCreationAddress: string;
  poolBatchingAddress: string;
};

type OutRef = { txHash: string; outputIndex: number };

export type MinswapV2DeployedScripts = {
  factory: OutRef;
  authen: OutRef;
};

export const MINSWAP_V2_CONFIG: Record<'mainnet' | 'testnet', MinswapV2Config> = {
  testnet: {
    lpPolicyId: 'd6aae2059baee188f74917493cf7637e679cd219bdfbbf4dcbeb1d0b',
    factoryAsset: 'd6aae2059baee188f74917493cf7637e679cd219bdfbbf4dcbeb1d0b4d5346',
    poolAuthenAsset: 'd6aae2059baee188f74917493cf7637e679cd219bdfbbf4dcbeb1d0b4d5350',
    factoryScriptHashBech32: 'script1dc3lu9ettdgw9t2e4hkea6x53rm5cl6xsmu3kqezyzk66vpljxc',
    factoryAddress:
      'addr_test1zphz8lsh9dd4pc4dtxk7m8hg6jy0wnrlg6r0jxcrygs2mtvrajt8r8wqtygrfduwgukk73m5gcnplmztc5tl5ngy0upqjgg24z',
    poolCreationAddress:
      'addr_test1zrtt4xm4p84vse3g3l6swtf2rqs943t0w39ustwdszxt3l5rajt8r8wqtygrfduwgukk73m5gcnplmztc5tl5ngy0upqhns793',
    poolBatchingAddress: 'stake_test17rann6nth9675m0y5tz32u3rfhzcfjymanxqnfyexsufu5glcajhf',
  },
  mainnet: {
    lpPolicyId: 'f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c',
    factoryAsset: 'f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c4d5346',
    poolAuthenAsset: 'f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c4d5350',
    factoryScriptHashBech32: 'script100zlh4q6jh6kr05yx6trrc8rtz27lv9h8c98fq9mnmtnqfa47eg',
    factoryAddress:
      'addr1z9aut775r22l2cd7ssmfvv0qudvftmaskulq5ayqhw0dwvzj2c79gy9l76sdg0xwhd7r0c0kna0tycz4y5s6mlenh8pqgjw6pl',
    poolCreationAddress:
      'addr1z84q0denmyep98ph3tmzwsmw0j7zau9ljmsqx6a4rvaau66j2c79gy9l76sdg0xwhd7r0c0kna0tycz4y5s6mlenh8pq777e2a',
    poolBatchingAddress: 'stake17y02a946720zw6pw50upt2arvxsvvpvaghjtl054h0f0gjsfyjz59',
  },
};

export const MINSWAP_V2_DEPLOYED_SCRIPTS: Record<'mainnet' | 'testnet', MinswapV2DeployedScripts> = {
  testnet: {
    factory: { txHash: '9741d59656e9ad54f197b0763482eede9a6fa1616c4547797eee6617f92a1396', outputIndex: 0 },
    authen: { txHash: 'c429b8ee27e5761ba8714e26e3a5899886cd28d136d43e969d4bc1acf0f72d4a', outputIndex: 0 },
  },
  mainnet: {
    factory: { txHash: '59c7fa5c30cbab4e6d38f65e15d1adef71495321365588506ad089d237b602e0', outputIndex: 0 },
    authen: { txHash: 'dbc1498500a6e79baa0f34d10de55cdb4289ca6c722bd70e1e1b78a858f136b9', outputIndex: 0 },
  },
};

export const MINSWAP_V2 = {
  MAX_LIQUIDITY: 9_223_372_036_854_775_807n,
  /** ADA locked in every pool UTxO on top of the ADA reserve. */
  DEFAULT_POOL_ADA: 4_500_000n,
  /** Liquidity permanently locked in the pool at creation. */
  MINIMUM_LIQUIDITY: 10n,
  /** Trading fee numerator bounds (denominator 10000): 0.05% .. 20%. */
  MIN_TRADING_FEE: 5n,
  MAX_TRADING_FEE: 2000n,
  CREATE_POOL_METADATA: 'L4VA: Minswap V2 Create Pool',
};
