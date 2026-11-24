import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from 'viem';

import { BlockchainWebhookService } from './blockchain-webhook.service';
import { EvmVaultContributionService } from './evm-vault-contribution.service';
import { VAULT_ABI } from './vault.abi';

import { TransactionStatus, TransactionType } from '@/types/transaction.types';

// Injected as mocks below; their own `src/...` imports do not resolve under jest.
jest.mock('../offchain-tx/transactions.service', () => ({ TransactionsService: class {} }));

type Fn = (...args: any[]) => any;

const VAULT: Address = '0x00000000000000000000000000000000000000aa';
const ALICE: Address = '0x000000000000000000000000000000000000a11c';
const BOB: Address = '0x0000000000000000000000000000000000000b0b';
const HASH: Hex = `0x${'22'.repeat(32)}`;

function contributionMadeLog(contributor: Address, address: Address = VAULT) {
  return {
    address,
    topics: encodeEventTopics({
      abi: VAULT_ABI,
      eventName: 'ContributionMade',
      args: { contributionId: 1n, cycleId: 1n, contributor },
    }),
    data: encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }],
      [0, '0x0000000000000000000000000000000000000000', 0n, 10n ** 18n, `0x${'00'.repeat(32)}`]
    ),
  };
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function buildConfirm(opts: { receipt: unknown; clash?: boolean }) {
  const qb: Record<string, Fn> = {};
  for (const m of ['where', 'andWhere']) qb[m] = () => qb;
  qb.getExists = async () => !!opts.clash;
  const transactionRepository = {
    findOne: jest.fn<Fn>(async () => ({
      id: 'tx-1',
      user_id: 'u1',
      vault_id: 'v1',
      type: TransactionType.acquire,
      metadata: { assets: [] },
      user: { address: ALICE },
    })),
    createQueryBuilder: jest.fn<Fn>(() => qb),
    count: jest.fn<Fn>(async () => 0),
    update: jest.fn<Fn>(async () => ({ affected: 1 })),
    manager: { count: jest.fn<Fn>(async () => 0) },
  };
  const transactionsService = {
    createAssets: jest.fn<Fn>(async () => ({ success: true })),
    updateTransactionHash: jest.fn<Fn>(async () => undefined),
    updateTransactionStatusById: jest.fn<Fn>(async () => undefined),
  };
  const contractReader = {
    getTransactionReceipt: jest.fn<Fn>(async () => {
      if (opts.receipt === null) throw new Error('TransactionReceiptNotFoundError');
      return opts.receipt;
    }),
  };
  const service = new EvmVaultContributionService(
    { findOne: jest.fn<Fn>(async () => ({ id: 'v1', contract_address: VAULT })) } as any,
    transactionRepository as any,
    transactionsService as any,
    { get: () => '46630' } as any,
    { applyEvmTransactionStatus: jest.fn<Fn>(async () => null) } as any,
    contractReader as any,
    { reconcileLogs: jest.fn<Fn>(async () => ({ processed: 0, skipped: 0, errors: 0, perTx: new Map() })) } as any,
    {} as any,
    {} as any,
    { sendAlert: jest.fn() } as any,
    { mintingAddress: '0x00000000000000000000000000000000000000ff' } as any,
    {} as any
  );
  return { service, transactionsService };
}

describe('POST /blockchain/evm/contribution/confirm — the hash must be a contribution of the caller', () => {
  it('refuses a mined hash with no ContributionMade from this vault for the caller, writing nothing', async () => {
    const { service, transactionsService } = buildConfirm({
      receipt: { status: 'success', logs: [contributionMadeLog(BOB)] }, // someone else's contribution
    });
    await expect(service.confirmContribution('tx-1', HASH, 'u1')).rejects.toThrow(BadRequestException);
    expect(transactionsService.createAssets).not.toHaveBeenCalled();
    expect(transactionsService.updateTransactionHash).not.toHaveBeenCalled();
  });

  it('refuses any successful transaction that is not a contribution (e.g. a plain transfer)', async () => {
    const { service } = buildConfirm({ receipt: { status: 'success', logs: [] } });
    await expect(service.confirmContribution('tx-1', HASH, 'u1')).rejects.toThrow(
      'This transaction is not a contribution of yours to this vault'
    );
  });

  it('refuses a ContributionMade emitted by another contract', async () => {
    const { service } = buildConfirm({
      receipt: { status: 'success', logs: [contributionMadeLog(ALICE, '0x00000000000000000000000000000000000000ee')] },
    });
    await expect(service.confirmContribution('tx-1', HASH, 'u1')).rejects.toThrow(BadRequestException);
  });

  it('refuses a hash another transaction already holds', async () => {
    const { service } = buildConfirm({ receipt: null, clash: true });
    await expect(service.confirmContribution('tx-1', HASH, 'u1')).rejects.toThrow(
      'This transaction hash is already recorded for another transaction'
    );
  });

  it("accepts the caller's own contribution", async () => {
    const { service, transactionsService } = buildConfirm({
      receipt: { status: 'success', logs: [contributionMadeLog(ALICE)] },
    });
    await expect(service.confirmContribution('tx-1', HASH, 'u1')).resolves.toEqual({ success: true, txHash: HASH });
    expect(transactionsService.updateTransactionHash).toHaveBeenCalledWith('tx-1', HASH);
  });

  it('accepts a hash whose receipt is not visible yet (nothing is confirmed from it)', async () => {
    const { service, transactionsService } = buildConfirm({ receipt: null });
    await expect(service.confirmContribution('tx-1', HASH, 'u1')).resolves.toEqual({ success: true, txHash: HASH });
    expect(transactionsService.createAssets).toHaveBeenCalledWith('tx-1');
  });
});

describe('BlockchainWebhookService.applyEvmTransactionStatus — a successful receipt does not confirm a contribution', () => {
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  function buildWebhook(type: TransactionType) {
    const service = Object.create(BlockchainWebhookService.prototype) as BlockchainWebhookService;
    const applyTransactionStatus = jest.fn<Fn>(async () => 'applied');
    Object.assign(service, {
      vaultCreatedTopic: '0xdead',
      transactionRepository: { findOne: jest.fn<Fn>(async () => ({ id: 'tx-1', type })) },
      applyTransactionStatus,
    });
    return { service, applyTransactionStatus };
  }

  it.each([TransactionType.contribute, TransactionType.acquire])(
    '%s: left to the vault event reconciler',
    async type => {
      const { service, applyTransactionStatus } = buildWebhook(type);
      expect(await service.applyEvmTransactionStatus(HASH, 0, TransactionStatus.confirmed, [])).toBe('tx-1');
      expect(applyTransactionStatus).not.toHaveBeenCalled();
    }
  );

  it('a reverted contribution is still marked failed', async () => {
    const { service, applyTransactionStatus } = buildWebhook(TransactionType.contribute);
    await service.applyEvmTransactionStatus(HASH, 0, TransactionStatus.failed, []);
    expect(applyTransactionStatus).toHaveBeenCalledWith(HASH, 0, TransactionStatus.failed);
  });

  it('other transaction types are confirmed from the receipt as before', async () => {
    const { service, applyTransactionStatus } = buildWebhook(TransactionType.createVault);
    await service.applyEvmTransactionStatus(HASH, 0, TransactionStatus.confirmed, []);
    expect(applyTransactionStatus).toHaveBeenCalledWith(HASH, 0, TransactionStatus.confirmed);
  });
});
