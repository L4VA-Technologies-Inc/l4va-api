import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { DistributionService } from './distribution.service';
import { DistributionBatchStatus, DistributionMetadata } from './dto/distribution.dto';

import { Claim } from '@/database/claim.entity';
import { Proposal } from '@/database/proposal.entity';
import { UtxoSpentException } from '@/modules/vaults/processing-tx/onchain/exceptions/utxo-spent.exception';
import { ValidityIntervalException } from '@/modules/vaults/processing-tx/onchain/exceptions/validity-interval.exception';
import { ValueNotConservedException } from '@/modules/vaults/processing-tx/onchain/exceptions/value-not-conserved.exception';

const PROPOSAL_ID = 'proposal-1';
const VAULT_ID = 'vault-1';
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/**
 * In-memory stand-ins for the repositories and chain services the distribution
 * flow touches, so the tests can count how many times a batch is built and
 * submitted across runs.
 */
function setup() {
  const proposalRow: { id: string; vaultId: string; snapshotId: string; metadata: any } = {
    id: PROPOSAL_ID,
    vaultId: VAULT_ID,
    snapshotId: 'snapshot-1',
    metadata: { distributionLovelaceAmount: '10000000' },
  };
  const proposalRepository = {
    findOne: jest.fn(async () => clone(proposalRow)),
    update: jest.fn(async (_where: unknown, patch: { metadata: unknown }) => {
      proposalRow.metadata = clone(patch.metadata);
      return { affected: 1 };
    }),
  };

  const claims = new Map<string, any>();
  let claimSeq = 0;
  const saveClaims = jest.fn(async (rows: any[]) =>
    rows.map(row => {
      const saved = { ...row, id: row.id ?? `claim-${++claimSeq}` };
      claims.set(saved.id, saved);
      return saved;
    })
  );
  const claimRepository = {
    find: jest.fn(async (opts: any) => (opts.where.id.value as string[]).map(id => clone(claims.get(id)))),
    save: jest.fn(async (rows: any[]) => rows.forEach(r => claims.set(r.id, clone(r)))),
    update: jest.fn(async (ids: string[], patch: any) => ids.forEach(id => Object.assign(claims.get(id), patch))),
    manager: {
      transaction: async (cb: (m: unknown) => Promise<unknown>) =>
        cb({
          getRepository: (entity: unknown) => {
            if (entity === Claim) return { save: saveClaims };
            if (entity === Proposal) return { update: proposalRepository.update };
            throw new Error('unexpected repository');
          },
        }),
    },
  };

  const transactions: any[] = [];
  const transactionRepository = {
    findOne: jest.fn(async (opts: any) => transactions.find(t => t.tx_hash === opts.where.tx_hash) ?? null),
    save: jest.fn(async (row: any) => {
      const saved = { ...row, id: `tx-row-${transactions.length + 1}` };
      transactions.push(saved);
      return saved;
    }),
  };

  const blockchainService = { submitTransaction: jest.fn(async (_tx: { transaction: string }) => ({ txHash: 'x' })) };
  const alertsService = { sendAlert: jest.fn(async () => undefined) };
  const configService = {
    get: (key: string) => (key === 'BLOCKFROST_API_KEY' ? 'preprodTestKey' : 'testnet'),
  };

  const service = new DistributionService(
    { findOne: async () => ({ id: VAULT_ID }) } as any,
    claimRepository as any,
    { findOne: async () => ({ addressBalances: { addr_a: '100', addr_b: '300' } }) } as any,
    { find: async () => [] } as any,
    proposalRepository as any,
    transactionRepository as any,
    configService as any,
    blockchainService as any,
    { getTreasuryWallet: async () => ({ address: 'addr_treasury' }) } as any,
    { emit: jest.fn() } as any,
    alertsService as any
  );

  // One recipient per batch, so two holders make two batches.
  (service as any).MAX_RECIPIENTS_PER_BATCH = 1;
  jest.spyOn(service as any, 'delay').mockImplementation(async () => undefined);

  const blockfrost = { txs: jest.fn(async (_hash: string): Promise<unknown> => ({})) };
  (service as any).blockfrost = blockfrost;

  // Each build produces a fresh, distinct signed tx.
  let buildSeq = 0;
  const build = jest
    .spyOn(service as any, 'buildSignedDistributionTx')
    .mockImplementation(async () => ({ txHash: `hash-${++buildSeq}`, signedTx: `signed-${buildSeq}` }));

  const run = () => service.executeDistribution({ ...clone(proposalRow) } as unknown as Proposal);
  const plan = () => proposalRow.metadata.distribution as DistributionMetadata;

  return { service, proposalRow, blockchainService, blockfrost, alertsService, saveClaims, build, run, plan };
}

const notFound = () => Object.assign(new Error('not found'), { status_code: 404 });

describe('DistributionService: never pays a batch twice', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('pays every batch once and a second run only resumes the existing plan', async () => {
    expect(await t.run()).toBe(true);
    expect(t.blockchainService.submitTransaction).toHaveBeenCalledTimes(2);
    expect(t.saveClaims).toHaveBeenCalledTimes(1);

    expect(await t.run()).toBe(true);
    expect(t.blockchainService.submitTransaction).toHaveBeenCalledTimes(2);
    expect(t.build).toHaveBeenCalledTimes(2);
    expect(t.saveClaims).toHaveBeenCalledTimes(1);
    expect(t.plan().batches.every(b => b.status === DistributionBatchStatus.COMPLETED)).toBe(true);
    expect(t.plan().batches.every(b => b.signedTx === undefined)).toBe(true);
  });

  it('after a node rejection, only the rejected batch is rebuilt', async () => {
    t.blockchainService.submitTransaction
      .mockImplementationOnce(async () => ({ txHash: 'hash-1' }))
      .mockImplementationOnce(async () => {
        throw new ValueNotConservedException('1 ADA', '2 ADA');
      });

    expect(await t.run()).toBe(false);
    expect(t.plan().batches.map(b => b.status)).toEqual([
      DistributionBatchStatus.COMPLETED,
      DistributionBatchStatus.RETRY_PENDING,
    ]);
    expect(t.plan().batches[1].txHash).toBeUndefined();

    expect(await t.run()).toBe(true);
    expect(t.build).toHaveBeenCalledTimes(3); // batch 1 once, batch 2 twice
    expect(t.blockchainService.submitTransaction.mock.calls.map(c => c[0].transaction)).toEqual([
      'signed-1',
      'signed-2',
      'signed-3',
    ]);
  });

  it('persists the tx hash and signed tx before submitting', async () => {
    t.blockchainService.submitTransaction.mockImplementation(async () => {
      const batch = t.plan().batches.find(b => b.status === DistributionBatchStatus.PROCESSING)!;
      expect(batch.txHash).toBeDefined();
      expect(batch.signedTx).toBeDefined();
      return { txHash: batch.txHash! };
    });
    expect(await t.run()).toBe(true);
  });

  it('unknown submit outcome: the batch is settled from chain, never rebuilt', async () => {
    t.blockchainService.submitTransaction.mockImplementation(async () => {
      throw new Error('Failed to submit transaction: socket hang up');
    });

    expect(await t.run()).toBe(false);
    expect(t.plan().batches.map(b => b.status)).toEqual([
      DistributionBatchStatus.PROCESSING,
      DistributionBatchStatus.PROCESSING,
    ]);
    expect(t.plan().batches.map(b => b.txHash)).toEqual(['hash-1', 'hash-2']);

    // Both txs did land.
    t.blockfrost.txs.mockResolvedValue({});
    t.blockchainService.submitTransaction.mockClear();

    expect(await t.run()).toBe(true);
    expect(t.build).toHaveBeenCalledTimes(2);
    expect(t.blockchainService.submitTransaction).not.toHaveBeenCalled();
  });

  it('unknown submit outcome and not on chain: resubmits the SAME signed tx', async () => {
    t.blockchainService.submitTransaction.mockImplementationOnce(async () => {
      throw new Error('Failed to submit transaction: timeout');
    });
    await t.run();
    expect(t.plan().batches[0].status).toBe(DistributionBatchStatus.PROCESSING);

    t.blockfrost.txs.mockRejectedValue(notFound());
    t.blockchainService.submitTransaction.mockClear();

    expect(await t.run()).toBe(true);
    expect(t.build).toHaveBeenCalledTimes(2);
    expect(t.blockchainService.submitTransaction.mock.calls.map(c => c[0].transaction)).toEqual(['signed-1']);
  });

  it('resubmission fails with spent inputs: stays in flight and alerts, no rebuild', async () => {
    t.blockchainService.submitTransaction.mockImplementationOnce(async () => {
      throw new Error('Failed to submit transaction: 502');
    });
    await t.run();

    t.blockfrost.txs.mockRejectedValue(notFound());
    t.blockchainService.submitTransaction.mockImplementation(async () => {
      throw new UtxoSpentException('abc', 0);
    });

    expect(await t.run()).toBe(false);
    expect(t.plan().batches[0].status).toBe(DistributionBatchStatus.PROCESSING);
    expect(t.plan().batches[0].txHash).toBe('hash-1');
    expect(t.build).toHaveBeenCalledTimes(2);
    expect(t.alertsService.sendAlert).toHaveBeenCalledWith('distribution_batch_unconfirmed', expect.anything());
  });

  it('a tx that is not on chain and has expired is rebuilt', async () => {
    t.blockchainService.submitTransaction.mockImplementationOnce(async () => {
      throw new Error('Failed to submit transaction: timeout');
    });
    await t.run();

    t.blockfrost.txs.mockRejectedValue(notFound());
    t.blockchainService.submitTransaction
      .mockImplementationOnce(async () => {
        throw new ValidityIntervalException(1, 2, 3);
      })
      .mockImplementation(async () => ({ txHash: 'ok' }));

    expect(await t.run()).toBe(true);
    expect(t.build).toHaveBeenCalledTimes(3); // batch 1 rebuilt once
  });

  it('a batch interrupted before submission (no tx hash) is sent', async () => {
    await t.run();
    const batch = t.plan().batches[0];
    batch.status = DistributionBatchStatus.PROCESSING;
    batch.txHash = undefined;
    batch.signedTx = undefined;
    t.blockchainService.submitTransaction.mockClear();

    expect(await t.run()).toBe(true);
    expect(t.blockchainService.submitTransaction).toHaveBeenCalledTimes(1);
  });

  it('never resumes a plan written by the old code', async () => {
    t.proposalRow.metadata.distribution = {
      totalLovelaceToDistribute: '10000000',
      totalRecipients: 1,
      lovelacePerHolder: '10000000',
      minLovelacePerHolder: '10000000',
      completedBatches: 0,
      failedBatches: 0,
      batches: [
        {
          batchId: 'b1',
          batchNumber: 1,
          totalBatches: 1,
          recipientCount: 1,
          lovelaceAmount: '10000000',
          status: DistributionBatchStatus.RETRY_PENDING,
          claimIds: ['claim-x'],
          retryCount: 1,
        },
      ],
    } satisfies DistributionMetadata;

    expect(await t.run()).toBe(false);
    expect(t.build).not.toHaveBeenCalled();
    expect(t.blockchainService.submitTransaction).not.toHaveBeenCalled();
    expect(t.saveClaims).not.toHaveBeenCalled();
    expect(t.alertsService.sendAlert).toHaveBeenCalledWith('distribution_legacy_plan_unfinished', expect.anything());
  });
});
