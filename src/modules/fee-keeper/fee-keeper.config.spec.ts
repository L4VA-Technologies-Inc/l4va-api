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
        kind: 'v3',
        path: ['0x0bd7d308f8e1639fab988df18a8011f41eacad73', 100, '0x5fc5360d0400a0fd4f2af552add042d716f1d168'],
      },
    },
  ]),
};

describe('fee-keeper config', () => {
  it('is disabled by default and needs nothing else', () => {
    const cfg = loadFeeKeeperConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.buyback.enabled).toBe(false);
  });

  it('parses a complete config with defaults', () => {
    const cfg = loadFeeKeeperConfig(base);
    expect(cfg.enabled).toBe(true);
    expect(cfg.routes).toHaveLength(1);
    expect(cfg.routes[0].encoded.startsWith('0x')).toBe(true);
    expect(cfg.slippageBps).toBe(100);
    expect(cfg.maxRetries).toBe(3);
    expect(cfg.buyback.enabled).toBe(false);
  });

  it('rejects missing or invalid required values when enabled', () => {
    expect(() => loadFeeKeeperConfig({ ...base, FEE_KEEPER_PRIVATE_KEY: '0x1234' })).toThrow(/PRIVATE_KEY/);
    expect(() => loadFeeKeeperConfig({ ...base, FEE_CONVERTER_ADDRESS: 'nope' })).toThrow(/FEE_CONVERTER_ADDRESS/);
    expect(() => loadFeeKeeperConfig({ ...base, FEE_KEEPER_ROUTES_JSON: '{' })).toThrow(/JSON/);
    expect(() => loadFeeKeeperConfig({ ...base, FEE_KEEPER_SLIPPAGE_BPS: '5000' })).toThrow(/SLIPPAGE/);
  });

  it('rejects duplicate route assets and invalid routes', () => {
    const routes = JSON.parse(base.FEE_KEEPER_ROUTES_JSON);
    expect(() => loadFeeKeeperConfig({ ...base, FEE_KEEPER_ROUTES_JSON: JSON.stringify([routes[0], routes[0]]) })).toThrow(
      /duplicate/
    );
    const bad = [{ asset: routes[0].asset, route: { kind: 'v3', path: [routes[0].route.path[0], 2500, routes[0].route.path[2]] } }];
    expect(() => loadFeeKeeperConfig({ ...base, FEE_KEEPER_ROUTES_JSON: JSON.stringify(bad) })).toThrow(/route invalid/);
  });

  it('requires executor and route when the buyback stage is enabled', () => {
    expect(() => loadFeeKeeperConfig({ ...base, BUYBACK_KEEPER_ENABLED: 'true' })).toThrow(/BUYBACK_ROUTE_JSON/);
    const cfg = loadFeeKeeperConfig({
      ...base,
      BUYBACK_KEEPER_ENABLED: 'true',
      BUYBACK_EXECUTOR_ADDRESS: '0x1000000000000000000000000000000000000004',
      BUYBACK_ROUTE_JSON: JSON.stringify({
        kind: 'v3',
        path: ['0x5fc5360d0400a0fd4f2af552add042d716f1d168', 3000, '0x2000000000000000000000000000000000000005'],
      }),
      BUYBACK_MIN_RESERVE: '1000000',
    });
    expect(cfg.buyback.enabled).toBe(true);
    expect(cfg.buyback.minReserve).toBe(1_000_000n);
    expect(cfg.buyback.encodedRoute).toBeDefined();
  });
});
