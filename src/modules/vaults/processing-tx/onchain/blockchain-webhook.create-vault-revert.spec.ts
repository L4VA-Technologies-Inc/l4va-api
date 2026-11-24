import { describe, expect, it, jest } from '@jest/globals';
import { FindOperator } from 'typeorm';

import { BlockchainWebhookService } from './blockchain-webhook.service';

import { TransactionStatus, TransactionType } from '@/types/transaction.types';
import { ChainType, VaultStatus } from '@/types/vault.types';

// Injected as mocks below; their own `src/...` imports do not resolve under jest.
jest.mock('../offchain-tx/transactions.service', () => ({ TransactionsService: class {} }));
jest.mock('./evm-vault-signer.service', () => ({ EvmVaultSignerService: class {} }));

type Fn = (...args: any[]) => any;

const TX_HASH = `0x${'ab'.repeat(32)}`;

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function build(tx: { id: string; type: TransactionType; vault_id: string | null } | null, affected = 1) {
  const transactionsService = {
    updateTransactionStatusByHash: jest.fn<Fn>(async () => (tx ? { ...tx, status: TransactionStatus.failed } : null)),
  };
  const transactionRepository = { findOne: jest.fn<Fn>(async () => tx) };
  const vaultRepository = { update: jest.fn<Fn>(async () => ({ affected })) };

  const service = new BlockchainWebhookService(
    transactionsService as any,
    { get: () => undefined } as any,
    {} as any,
    {} as any,
    { updateVaultFromCreatedEvent: jest.fn() } as any,
    {} as any,
    {} as any,
    {} as any,
    vaultRepository as any,
    transactionRepository as any,
    {} as any
  );
  return { service, vaultRepository };
}

describe('BlockchainWebhookService — reverted EVM createVault', () => {
  it('returns the vault this transaction published to draft', async () => {
    const { service, vaultRepository } = build({ id: 't1', type: TransactionType.createVault, vault_id: 'v1' });

    await service.applyEvmTransactionStatus(TX_HASH, 0, TransactionStatus.failed, []);

    expect(vaultRepository.update).toHaveBeenCalledTimes(1);
    const [where, set] = vaultRepository.update.mock.calls[0] as [any, any];
    // Only the exact vault this hash published, still without a contract.
    expect(where).toMatchObject({
      id: 'v1',
      chain_type: ChainType.robinhood,
      vault_status: VaultStatus.published,
      publication_hash: TX_HASH,
    });
    expect(where.contract_address).toBeInstanceOf(FindOperator);
    expect(where.contract_address.type).toBe('isNull');
    expect(set).toEqual({ vault_status: VaultStatus.draft, publication_hash: null });
  });

  it('leaves the vault alone when the creation succeeded', async () => {
    const { service, vaultRepository } = build({ id: 't1', type: TransactionType.createVault, vault_id: 'v1' });
    (service as any).handleCreateVaultConfirmation = jest.fn(async () => undefined);

    await service.applyEvmTransactionStatus(TX_HASH, 0, TransactionStatus.confirmed, []);

    expect(vaultRepository.update).not.toHaveBeenCalled();
  });

  it('ignores reverted transactions that are not a vault creation', async () => {
    const { service, vaultRepository } = build({ id: 't1', type: TransactionType.contribute, vault_id: 'v1' });

    await service.applyEvmTransactionStatus(TX_HASH, 0, TransactionStatus.failed, []);

    expect(vaultRepository.update).not.toHaveBeenCalled();
  });

  it('does nothing for an unknown hash', async () => {
    const { service, vaultRepository } = build(null);

    await service.applyEvmTransactionStatus(TX_HASH, 0, TransactionStatus.failed, []);

    expect(vaultRepository.update).not.toHaveBeenCalled();
  });
});
