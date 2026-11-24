import { describe, expect, it } from '@jest/globals';

import { loadFeeKeeperConfig } from './fee-keeper.config';

const KEY = `0x${'11'.repeat(32)}`;
const base = {
  FEE_KEEPER_ENABLED: 'true',
  EVM_RPC_URL: 'http://localhost:8545',
  FEE_KEEPER_PRIVATE_KEY: KEY,
  FEE_CONVERTER_ADDRESS: '0x1000000000000000000000000000000000000001',
  FEE_CONTROLLER_ADDRESS: '0x1000000000000000000000000000000000000002',
  FEE_SWAP_ADAPTER_ADDRESS: '0x1000000000000000000000000000000000000003',
  FEE_KEEPER_WETH_ADDRESS: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  FEE_KEEPER_ROUTES_JSON: JSON.stringify([
    {
      asset: '0x0000000000000000000000000000000000000000',
      route: {
        kind: 'v4',
        currency0: '0x0000000000000000000000000000000000000000',
        currency1: '0x0c020bef365d7001611ef1cecd6084cdd6b73683',
        fee: 10_000,
        tickSpacing: 200,
        zeroForOne: true,
      },
    },
  ]),
};

describe('fee-keeper config', () => {
  it('is disabled by default and needs nothing else', () => {
    const cfg = loadFeeKeeperConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.distribute.enabled).toBe(false);
  });

  it('parses a complete config with defaults', () => {
    const cfg = loadFeeKeeperConfig(base);
    expect(cfg.enabled).toBe(true);
    expect(cfg.routes).toHaveLength(1);
    expect(cfg.routes[0].encoded.startsWith('0x')).toBe(true);
    expect(cfg.slippageBps).toBe(100);
    expect(cfg.maxRetries).toBe(3);
    expect(cfg.buy).toEqual({ minIntervalMinutes: 60, maxIntervalMinutes: 240, minChunkBps: 3000 });
    expect(cfg.distribute.enabled).toBe(false);
  });

  it('rejects missing or invalid required values when enabled', () => {
    expect(() => loadFeeKeeperConfig({ ...base, FEE_KEEPER_PRIVATE_KEY: '0x1234' })).toThrow(/PRIVATE_KEY/);
    expect(() => loadFeeKeeperConfig({ ...base, FEE_CONVERTER_ADDRESS: 'nope' })).toThrow(/FEE_CONVERTER_ADDRESS/);
    expect(() => loadFeeKeeperConfig({ ...base, FEE_KEEPER_ROUTES_JSON: '{' })).toThrow(/JSON/);
    expect(() => loadFeeKeeperConfig({ ...base, FEE_KEEPER_SLIPPAGE_BPS: '5000' })).toThrow(/SLIPPAGE/);
  });

  it('rejects duplicate route assets and invalid routes', () => {
    const routes = JSON.parse(base.FEE_KEEPER_ROUTES_JSON);
    expect(() =>
      loadFeeKeeperConfig({ ...base, FEE_KEEPER_ROUTES_JSON: JSON.stringify([routes[0], routes[0]]) })
    ).toThrow(/duplicate/);
    const bad = [{ asset: routes[0].asset, route: { ...routes[0].route, currency0: routes[0].route.currency1 } }];
    expect(() => loadFeeKeeperConfig({ ...base, FEE_KEEPER_ROUTES_JSON: JSON.stringify(bad) })).toThrow(
      /route invalid/
    );
  });

  it('validates the random buy window', () => {
    expect(() =>
      loadFeeKeeperConfig({ ...base, FEE_KEEPER_MIN_INTERVAL_MINUTES: '300', FEE_KEEPER_MAX_INTERVAL_MINUTES: '60' })
    ).toThrow(/INTERVAL/);
    expect(() => loadFeeKeeperConfig({ ...base, FEE_KEEPER_MIN_CHUNK_BPS: '0' })).toThrow(/CHUNK/);
  });

  it('requires treasury and ops addresses when distribution is enabled', () => {
    expect(() => loadFeeKeeperConfig({ ...base, FEE_KEEPER_DISTRIBUTE_ENABLED: 'true' })).toThrow(/TREASURY/);
    const cfg = loadFeeKeeperConfig({
      ...base,
      FEE_KEEPER_DISTRIBUTE_ENABLED: 'true',
      FEE_KEEPER_TREASURY_ADDRESS: '0x1000000000000000000000000000000000000004',
      FEE_KEEPER_OPS_ADDRESS: '0x1000000000000000000000000000000000000005',
    });
    expect(cfg.distribute).toEqual({
      enabled: true,
      treasury: '0x1000000000000000000000000000000000000004',
      operations: '0x1000000000000000000000000000000000000005',
    });
  });
});
