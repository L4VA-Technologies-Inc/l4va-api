import { describe, expect, it } from '@jest/globals';

import { checkEnv } from './env-check.rules';

const base = {
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_USERNAME: 'u',
  DB_PASSWORD: 'p',
  DB_NAME: 'n',
  JWT_SECRET: 's3cr3t-'.repeat(6),
  REDIS_HOST: 'localhost',
  SLACK_BOT_TOKEN: 'xoxb-1',
};
const keys = (env: Record<string, string>): string[] =>
  checkEnv(env)
    .filter(i => i.level === 'error')
    .map(i => i.key);

describe('checkEnv', () => {
  it('passes a coherent mainnet config', () => {
    const issues = checkEnv({
      ...base,
      NODE_ENV: 'production',
      CARDANO_NETWORK: 'mainnet',
      NETWORK_ID: '1',
      BLOCKFROST_API_KEY: 'mainnetAbc',
      ADMIN_ADDRESS: 'addr1qxyz',
      ANVIL_API_URL: 'https://prod.api.ada-anvil.app/v2',
      EVM_CHAIN_ID: '4663',
      UNISWAP_CHAIN_ID: '4663',
      ALCHEMY_NETWORK: 'robinhood-mainnet',
      EVM_RPC_URL: 'https://robinhood-mainnet.g.alchemy.com/v2/k',
    });
    expect(issues).toEqual([]);
  });

  it('flags testnet keys/addresses/URLs on a mainnet config', () => {
    expect(
      keys({
        ...base,
        CARDANO_NETWORK: 'mainnet',
        NETWORK_ID: '0',
        BLOCKFROST_API_KEY: 'preprodAbc',
        ADMIN_ADDRESS: 'addr_test1qxyz',
        ANVIL_API_URL: 'https://preprod.api.ada-anvil.app/v2',
        EVM_CHAIN_ID: '4663',
        UNISWAP_CHAIN_ID: '46630',
        ALCHEMY_NETWORK: 'robinhood-testnet',
        EVM_RPC_URL: 'https://rpc.testnet.chain.robinhood.com',
      }).sort()
    ).toEqual(
      [
        'ADMIN_ADDRESS',
        'ALCHEMY_NETWORK',
        'ANVIL_API_URL',
        'BLOCKFROST_API_KEY',
        'EVM_RPC_URL',
        'NETWORK_ID',
        'UNISWAP_CHAIN_ID',
      ].sort()
    );
  });

  it('flags malformed values and missing required keys', () => {
    const errs = keys({
      CARDANO_NETWORK: 'testnet',
      EVM_FACTORY_ADDRESS: '0x123',
      L4VA_POLICY_ID: 'abc',
      DB_PORT: 'x',
      EVM_RPC_URL: 'nope',
    });
    expect(errs).toEqual(
      expect.arrayContaining([
        'DB_HOST',
        'CARDANO_NETWORK',
        'EVM_FACTORY_ADDRESS',
        'L4VA_POLICY_ID',
        'DB_PORT',
        'EVM_RPC_URL',
        'BLOCKFROST_API_KEY',
      ])
    );
  });
});
