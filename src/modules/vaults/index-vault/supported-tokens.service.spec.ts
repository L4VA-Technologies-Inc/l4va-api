import { describe, expect, it, jest } from '@jest/globals';

import { SupportedTokensService } from './supported-tokens.service';

import { SupportedTokenRow } from '@/database/supported-token.entity';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mock = ReturnType<typeof jest.fn<(...args: any[]) => any>>;

const ADAPTER = '0x00000000000000000000000000000000000000aa';
const POOL_A = `0x${'a'.repeat(64)}`;
const POOL_B = `0x${'b'.repeat(64)}`;

function row(address: string, symbol: string, poolIds: string[]): SupportedTokenRow {
  return {
    chainId: 4663,
    address,
    symbol,
    name: `${symbol} token`,
    category: 'Stablecoin',
    liquidity: 'good',
    roundTripLossBps: 10,
    refEth: '0.1',
    poolIds,
    checkedAt: new Date('2026-11-25T12:00:00Z'),
    updatedAt: new Date('2026-11-25T12:00:00Z'),
  };
}

function setup(
  rows: SupportedTokenRow[],
  allowed: Set<string>,
  guarded = true
): {
  service: SupportedTokensService;
  repo: { find: Mock; create: Mock; manager: { transaction: Mock } };
  em: { delete: Mock; save: Mock };
  readContract: Mock;
} {
  const em = { delete: jest.fn(), save: jest.fn() };
  const repo = {
    find: jest.fn(async () => rows),
    create: jest.fn((x: unknown) => x),
    manager: { transaction: jest.fn((fn: (e: typeof em) => Promise<void>) => fn(em)) },
  };
  const readContract = jest.fn(async ({ functionName, args }: { functionName: string; args?: string[] }) => {
    if (functionName === 'dailyCapBps') {
      if (!guarded) throw new Error('not guarded');
      return 10_000;
    }
    if (functionName === 'poolAllowed') return allowed.has(args![0]);
    throw new Error(`unexpected ${functionName}`);
  });
  const service = new SupportedTokensService(
    repo as never,
    { tradingAdapterFor: () => ADAPTER } as never,
    { publicClient: { readContract } } as never,
    { get: () => '4663' } as never
  );
  return { service, repo, em, readContract };
}

describe('SupportedTokensService', () => {
  it('hides a token once one of its pools is no longer allowlisted', async () => {
    const { service } = setup([row('0x01', 'AAA', [POOL_A]), row('0x02', 'BBB', [POOL_A, POOL_B])], new Set([POOL_A]));
    const res = await service.list();
    expect(res.tokens.map(t => t.symbol)).toEqual(['AAA']);
    expect(res.refEth).toBe('0.1');
    expect(res.updatedAt).toBe('2026-11-25T12:00:00.000Z');
    expect(res.tokens[0]).not.toHaveProperty('poolIds');
  });

  it('shows the reviewed list as is when the adapter is not guarded', async () => {
    const { service } = setup([row('0x01', 'AAA', [POOL_A])], new Set(), false);
    expect((await service.list()).tokens).toHaveLength(1);
  });

  it('caches reads and drops the cache on replace', async () => {
    const { service, repo, em } = setup([row('0x01', 'AAA', [POOL_A])], new Set([POOL_A]));
    await service.list();
    await service.list();
    expect(repo.find).toHaveBeenCalledTimes(1);

    const res = await service.replace({
      refEth: '0.1',
      tokens: [
        {
          address: '0xC9A981FEE1F9DEC688BB123CCDECC63D0DEBFC4E',
          symbol: 'GLD',
          name: 'Gold',
          category: 'RWA - Robinhood stock token',
          liquidity: 'good',
          roundTripLossBps: 12,
          poolIds: [POOL_A.toUpperCase().replace('0X', '0x')],
          checkedAt: '2026-11-25T12:00:00Z',
        },
      ],
    });
    expect(res).toEqual({ count: 1 });
    expect(em.delete).toHaveBeenCalledWith(SupportedTokenRow, { chainId: 4663 });
    const saved = (em.save.mock.calls[0][1] as SupportedTokenRow[])[0];
    expect(saved.address).toBe('0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e');
    expect(saved.poolIds).toEqual([POOL_A]);

    await service.list();
    expect(repo.find).toHaveBeenCalledTimes(2);
  });
});
