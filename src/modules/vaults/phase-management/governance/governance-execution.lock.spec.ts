import { describe, expect, it, jest } from '@jest/globals';

import { GovernanceExecutionService } from './governance-execution.service';

/**
 * Emulates Postgres session advisory locks: one holder per key across all
 * "connections" (query runners) of the fake data source.
 */
function fakeDataSource() {
  const held = new Set<string>();
  return {
    held,
    createQueryRunner: () => ({
      connect: async () => undefined,
      release: async () => undefined,
      query: async (sql: string, [key]: [string]) => {
        if (sql.includes('pg_try_advisory_lock')) {
          if (held.has(key)) return [{ locked: false }];
          held.add(key);
          return [{ locked: true }];
        }
        if (sql.includes('pg_advisory_unlock')) {
          held.delete(key);
          return [{ pg_advisory_unlock: true }];
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
    }),
  };
}

function makeService() {
  // Skip the 25-dependency constructor: only the lock and the locked body matter here.
  const service = Object.create(GovernanceExecutionService.prototype) as any;
  service.logger = { log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  service.dataSource = fakeDataSource();
  return service;
}

describe('GovernanceExecutionService: one execution per proposal at a time', () => {
  it('a second concurrent execution of the same proposal is skipped', async () => {
    const service = makeService();
    let release!: () => void;
    const body = jest.fn(() => new Promise<void>(resolve => (release = resolve)));
    service.executePassedProposalLocked = body;

    const first = service.executePassedProposal('p1');
    await new Promise(r => setImmediate(r)); // let the first run take the lock
    await service.executePassedProposal('p1'); // e.g. the retry cron firing meanwhile

    expect(body).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(service.dataSource.held.size).toBe(0);
  });

  it('the retry cron skips a proposal that is being executed', async () => {
    const service = makeService();
    service.proposalRepository = { find: async () => [{ id: 'p1' }] };
    const retryBody = jest.fn(async () => undefined);
    service.retryPassedProposalLocked = retryBody;

    let release!: () => void;
    service.executePassedProposalLocked = () => new Promise<void>(resolve => (release = resolve));
    const running = service.executePassedProposal('p1');
    await new Promise(r => setImmediate(r));

    await service.retryPassedProposals();
    expect(retryBody).not.toHaveBeenCalled();

    release();
    await running;
    await service.retryPassedProposals();
    expect(retryBody).toHaveBeenCalledTimes(1);
  });

  it('different proposals do not block each other, and the lock is released on error', async () => {
    const service = makeService();
    service.executePassedProposalLocked = jest.fn(async (id: string) => {
      if (id === 'bad') throw new Error('boom');
    });

    await expect(service.executePassedProposal('bad')).rejects.toThrow('boom');
    await service.executePassedProposal('good');
    await service.executePassedProposal('bad').catch(() => undefined);

    expect(service.executePassedProposalLocked).toHaveBeenCalledTimes(3);
    expect(service.dataSource.held.size).toBe(0);
  });
});
