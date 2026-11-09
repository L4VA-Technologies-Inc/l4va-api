import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { CardanoAdminTxMonitorService } from './cardano-admin-tx-monitor.service';

// Jest has no mapping for the app's path aliases; only the injection token's name is used.
jest.mock('@/modules/redis/redis.module', () => ({ REDIS_CLIENT: 'REDIS_CLIENT' }), { virtual: true });
jest.mock('@/modules/alerts/alerts.service', () => ({ AlertsService: class {} }), { virtual: true });

const ADMIN = 'addr1admin';
const OTHER = 'addr1other';

type Tx = { tx_hash: string; block_height: number; block_time: number };

describe('CardanoAdminTxMonitorService', () => {
  let store: Map<string, string>;
  let known: Set<string>;
  let history: Tx[];
  let utxos: Record<string, { inputs: unknown[]; outputs: unknown[] }>;
  let sendAlert: jest.Mock<any>;
  let monitor: CardanoAdminTxMonitorService;

  const spend = (from: string, to: string, lovelace = '5000000') => ({
    inputs: [{ address: from, amount: [{ unit: 'lovelace', quantity: '9000000' }], collateral: false }],
    outputs: [{ address: to, amount: [{ unit: 'lovelace', quantity: lovelace }] }],
  });

  beforeEach(() => {
    store = new Map();
    known = new Set();
    history = [];
    utxos = {};
    sendAlert = jest.fn<any>().mockResolvedValue(undefined);

    const config: any = {
      get: (k: string) =>
        ({
          CARDANO_ADMIN_TX_MONITOR_ENABLED: 'true',
          ADMIN_ADDRESS: ADMIN,
          BLOCKFROST_API_KEY: 'mainnetTEST',
          NETWORK_ID: '1',
        })[k],
    };
    const redis: any = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => store.set(k, v),
    };
    const registry: any = { isKnown: async (h: string) => known.has(h) };

    monitor = new CardanoAdminTxMonitorService(config, registry, { sendAlert } as any, redis);
    (monitor as any).blockfrost = {
      // Blockfrost returns newest first.
      addressesTransactions: async () => [...history].sort((a, b) => b.block_height - a.block_height),
      txsUtxos: async (hash: string) => utxos[hash],
    };
  });

  const tx = (hash: string, height: number): Tx => ({ tx_hash: hash, block_height: height, block_time: 1_700_000_000 });

  it('only records the starting height on the first run', async () => {
    history = [tx('old', 100)];
    utxos.old = spend(ADMIN, OTHER);

    await monitor.check();

    expect(sendAlert).not.toHaveBeenCalled();
    expect(store.get('cardano:admin-monitor:last-block-height')).toBe('100');
  });

  it('alerts on an admin spend the backend did not submit', async () => {
    store.set('cardano:admin-monitor:last-block-height', '100');
    history = [tx('old', 100), tx('stolen', 101)];
    utxos.stolen = spend(ADMIN, OTHER, '7000000');

    await monitor.check();

    expect(sendAlert).toHaveBeenCalledTimes(1);
    const [type, data] = sendAlert.mock.calls[0] as [string, any];
    expect(type).toBe('cardano_admin_unknown_tx:stolen');
    expect(data.adaSentElsewhere).toBe('7.000000');
    expect(data.recipients).toEqual([OTHER]);
    expect(data.explorer).toBe('https://cardanoscan.io/transaction/stolen');
    expect(store.get('cardano:admin-monitor:last-block-height')).toBe('101');
  });

  it('stays quiet for transactions the backend submitted and for incoming payments', async () => {
    store.set('cardano:admin-monitor:last-block-height', '100');
    history = [tx('ours', 101), tx('deposit', 102)];
    known.add('ours');
    utxos.deposit = spend(OTHER, ADMIN);

    await monitor.check();

    expect(sendAlert).not.toHaveBeenCalled();
    expect(store.get('cardano:admin-monitor:last-block-height')).toBe('102');
  });

  it('keeps the cursor before a transaction it could not read, so it is retried', async () => {
    store.set('cardano:admin-monitor:last-block-height', '100');
    history = [tx('first', 101), tx('unreadable', 102)];
    utxos.first = spend(OTHER, ADMIN);
    (monitor as any).blockfrost.txsUtxos = async (hash: string) => {
      if (hash === 'unreadable') throw new Error('rate limited');
      return utxos[hash];
    };

    await monitor.check();

    expect(store.get('cardano:admin-monitor:last-block-height')).toBe('101');
  });

  it('does nothing when disabled', async () => {
    (monitor as any).enabled = false;
    history = [tx('stolen', 101)];

    await monitor.check();

    expect(store.size).toBe(0);
  });
});
