import { describe, expect, it, jest } from '@jest/globals';
import { FindOperator } from 'typeorm';

import { EvmContributionBackfillService } from './evm-contribution-backfill.service';

import { AssetStatus } from '@/types/asset.types';
import { ChainType } from '@/types/vault.types';

// Injected as a mock below; its own `src/...` imports do not resolve under jest.
jest.mock('./evm-vault-event-reconciler.service', () => ({ EvmVaultEventReconciler: class {} }));

type Fn = (...args: any[]) => any;

const VAULT_ADDRESS = '0x00000000000000000000000000000000000000aa';

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function build(opts: { onChain: bigint; inDb: number; staleIds: string[] }) {
  const wheres: string[] = [];
  const assetsQb: Record<string, Fn> = {};
  for (const m of ['select', 'where', 'andWhere']) {
    assetsQb[m] = (sql: string) => {
      if (m !== 'select') wheres.push(sql);
      return assetsQb;
    };
  }
  assetsQb.getRawMany = async () => opts.staleIds.map(id => ({ id }));

  const assetsRepository = {
    createQueryBuilder: jest.fn<Fn>(() => assetsQb),
    update: jest.fn<Fn>(async () => ({ affected: opts.staleIds.length })),
  };
  const vaultsRepository = {
    findOne: jest.fn<Fn>(async () => ({ id: 'v1', contract_address: VAULT_ADDRESS, chain_type: ChainType.robinhood })),
  };
  const contribsRepository = {
    count: jest.fn<Fn>(async () => opts.inDb),
    find: jest.fn<Fn>(async () => []),
  };
  const contractReader = {
    totalContributions: jest.fn<Fn>(async () => opts.onChain),
    publicClient: {
      getBlockNumber: jest.fn<Fn>(async () => 1_000n),
      getLogs: jest.fn<Fn>(async () => []),
    },
  };
  const reconciler = { reconcileLogs: jest.fn<Fn>(async () => ({ processed: 0, skipped: 0, errors: 0 })) };

  const service = new EvmContributionBackfillService(
    vaultsRepository as any,
    contribsRepository as any,
    assetsRepository as any,
    contractReader as any,
    reconciler as any,
    { get: () => undefined } as any
  );
  return { service, assetsRepository, wheres };
}

describe('EvmContributionBackfillService — Asset rows of contributions that never landed', () => {
  it('releases stale PENDING rows no contribution points at, once every on-chain contribution is indexed', async () => {
    const { service, assetsRepository, wheres } = build({ onChain: 2n, inDb: 2, staleIds: ['a3', 'a4'] });

    await service.backfillVault('v1');

    // Only rows of this vault, still PENDING, from a request, past the authorization window, unbound.
    expect(wheres.join(' ')).toContain('asset.vault_id');
    expect(wheres.join(' ')).toContain('asset.status = :pending');
    expect(wheres.join(' ')).toContain('asset.transaction_id IS NOT NULL');
    expect(wheres.join(' ')).toContain('asset.added_at < :cutoff');
    expect(wheres.join(' ')).toContain('NOT EXISTS (SELECT 1 FROM evm_contributions');

    expect(assetsRepository.update).toHaveBeenCalledTimes(1);
    const [where, set] = assetsRepository.update.mock.calls[0] as [any, any];
    expect(set).toEqual({ status: AssetStatus.RELEASED });
    // Conditional on PENDING and age, so a row locked in the meantime is left alone.
    expect(where.status).toBe(AssetStatus.PENDING);
    expect(where.id).toBeInstanceOf(FindOperator);
    expect(where.id.value).toEqual(['a3', 'a4']);
    const cutoff: Date = where.added_at.value;
    const ageMs = Date.now() - cutoff.getTime();
    // 1h authorization validity + 15 min margin.
    expect(ageMs).toBeGreaterThanOrEqual(75 * 60 * 1000 - 1_000);
    expect(ageMs).toBeLessThan(75 * 60 * 1000 + 60_000);
  });

  it('releases nothing while a landed contribution may still be unindexed', async () => {
    const { service, assetsRepository } = build({ onChain: 3n, inDb: 2, staleIds: ['a3'] });

    await service.backfillVault('v1');

    expect(assetsRepository.createQueryBuilder).not.toHaveBeenCalled();
    expect(assetsRepository.update).not.toHaveBeenCalled();
  });

  it('does nothing when there are no stale rows', async () => {
    const { service, assetsRepository } = build({ onChain: 1n, inDb: 1, staleIds: [] });

    await service.backfillVault('v1');

    expect(assetsRepository.update).not.toHaveBeenCalled();
  });
});
