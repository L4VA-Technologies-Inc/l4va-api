import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { toEventSelector } from 'viem';

import { EvmVaultSignerService } from './evm-vault-signer.service';

// Jest has no mapping for the app's path aliases, and only the classes' names are used here.
jest.mock('../offchain-tx/transactions.service', () => ({ TransactionsService: class {} }));
jest.mock('./evm-contract-reader.service', () => ({ EvmContractReader: class {} }));
jest.mock('@/database/user.entity', () => ({ User: class {} }), { virtual: true });
jest.mock('@/database/vault.entity', () => ({ Vault: class {} }), { virtual: true });
jest.mock('@/modules/alerts/alerts.service', () => ({ AlertsService: class {} }), { virtual: true });
jest.mock(
  '@/types/transaction.types',
  () => ({
    TransactionStatus: { confirmed: 'confirmed', failed: 'failed' },
    TransactionType: { createVault: 'create-vault' },
  }),
  { virtual: true }
);
jest.mock(
  '@/types/vault.types',
  () => ({ InvestmentWindowType: {}, VaultStatus: { published: 'published' } }),
  { virtual: true }
);

const addr = (n: string): string => `0x${n.repeat(40)}`;
const word = (a: string): string => `0x${'0'.repeat(24)}${a.slice(2)}`;

const FACTORY = addr('f');
const ADMIN = addr('a');
const MINTER = addr('b');
const OWNER = addr('c');
const VAULT = addr('d');
const FAKE = addr('e');
const VT = addr('9');
const ID = `0x${'1'.repeat(64)}`;
const TX = `0x${'2'.repeat(64)}`;

const CREATED = toEventSelector(
  'VaultCreated(bytes32 indexed vaultId, address indexed vault, address indexed creator, address admin, address vaultToken)'
);
const INITIALIZED = toEventSelector(
  'VaultInitialized(bytes32 indexed vaultId, address indexed admin, address mintingKey, address indexed vaultToken)'
);

const topicsFor = (vault: string, creator = OWNER): string[] => [CREATED, ID, word(vault), word(creator)];
const createdLog = (emitter: string, vault: string): object => ({ address: emitter, data: '0x', topics: topicsFor(vault) });
const initializedLog = (emitter: string, authority = ADMIN): object => ({
  address: emitter,
  data: word(MINTER),
  topics: [INITIALIZED, ID, word(authority), word(VT)],
});

describe('EvmVaultSignerService binding', () => {
  let service: EvmVaultSignerService;
  let vaultRecord: any;
  let txRecord: any;
  let hashOwner: any;
  let logs: any[];
  let approver: string;
  const save = jest.fn<any>();
  const updateHash = jest.fn<any>();
  const sendAlert = jest.fn<any>();

  beforeEach(() => {
    jest.clearAllMocks();
    approver = ADMIN;
    hashOwner = null;
    logs = [createdLog(FACTORY, VAULT), initializedLog(VAULT)];
    vaultRecord = { id: 'v1', evm_vault_id: ID, chain_id: 1, evm_protocol_version: null, contract_address: null };
    txRecord = { id: 't1', vault_id: 'v1', user_id: 'u1', type: 'create-vault', status: 'created', tx_hash: null };

    const vaults: any = {
      findOne: jest.fn<any>().mockImplementation(async ({ relations }: any) => {
        return relations ? { ...vaultRecord, owner: { id: 'u1', address: OWNER } } : vaultRecord;
      }),
      save,
    };
    const config: any = {
      get: (k: string) =>
        ({
          EVM_FACTORY_ADDRESS: FACTORY,
          EVM_ADMIN_ADDRESS: ADMIN,
          EVM_MINTING_SIGNER_ADDRESS: MINTER,
          EVM_CHAIN_ID: '1',
        })[k],
    };
    const transactions: any = {
      getTransactionById: jest.fn<any>().mockImplementation(async () => txRecord),
      getTransaction: jest.fn<any>().mockImplementation(async () => hashOwner),
      updateTransactionHash: updateHash,
    };
    const reader: any = {
      publicClient: {
        getTransactionReceipt: jest.fn<any>().mockImplementation(async () => ({ logs })),
        readContract: jest.fn<any>().mockImplementation(async () => approver),
      },
    };
    service = new EvmVaultSignerService(vaults, {} as any, config, transactions, reader, { sendAlert } as any);
  });

  describe('updateVaultFromCreatedEvent', () => {
    it('binds a vault our factory created from a config we approved', async () => {
      await service.updateVaultFromCreatedEvent(TX, topicsFor(VAULT), '0x');
      expect(vaultRecord.contract_address).toBe(VAULT);
      expect(sendAlert).not.toHaveBeenCalled();
    });

    it('refuses identical events emitted by a contract that is not the factory', async () => {
      logs = [createdLog(FAKE, FAKE), initializedLog(FAKE)];
      await service.updateVaultFromCreatedEvent(TX, topicsFor(FAKE), '0x');
      expect(save).not.toHaveBeenCalled();
      expect(sendAlert).toHaveBeenCalledWith('evm_vault_bind_refused', expect.anything());
    });

    it('refuses a factory vault with a different approver, so another treasury cannot be bound', async () => {
      approver = addr('7');
      await service.updateVaultFromCreatedEvent(TX, topicsFor(VAULT), '0x');
      expect(save).not.toHaveBeenCalled();
      expect(sendAlert).toHaveBeenCalled();
    });

    it('never overwrites an existing binding', async () => {
      vaultRecord.contract_address = VAULT;
      logs = [createdLog(FACTORY, FAKE), initializedLog(FAKE)];
      await service.updateVaultFromCreatedEvent(TX, topicsFor(FAKE), '0x');
      expect(vaultRecord.contract_address).toBe(VAULT);
      expect(save).not.toHaveBeenCalled();
      expect(sendAlert).toHaveBeenCalled();
    });

    it('treats a repeated event for the bound vault as a no-op', async () => {
      vaultRecord.contract_address = VAULT;
      await service.updateVaultFromCreatedEvent(TX, topicsFor(VAULT), '0x');
      expect(save).not.toHaveBeenCalled();
      expect(sendAlert).not.toHaveBeenCalled();
    });

    it('refuses the wrong creator and the wrong authority', async () => {
      await service.updateVaultFromCreatedEvent(TX, topicsFor(VAULT, addr('6')), '0x');
      logs = [createdLog(FACTORY, VAULT), initializedLog(VAULT, addr('6'))];
      await service.updateVaultFromCreatedEvent(TX, topicsFor(VAULT), '0x');
      expect(save).not.toHaveBeenCalled();
      expect(sendAlert).toHaveBeenCalledTimes(2);
    });
  });

  describe('confirmVaultCreation', () => {
    const confirm = (): Promise<void> => service.confirmVaultCreation('u1', 'v1', TX, 't1');

    it('accepts the creation record of this vault', async () => {
      await confirm();
      expect(updateHash).toHaveBeenCalledWith('t1', TX);
    });

    it.each([
      ['another vault', { vault_id: 'v2' }],
      ['another user', { user_id: 'u2' }],
      ['another transaction type', { type: 'contribute' }],
    ])('refuses a record of %s', async (_name, patch) => {
      Object.assign(txRecord, patch);
      await expect(confirm()).rejects.toThrow('does not belong');
      expect(updateHash).not.toHaveBeenCalled();
    });

    it('refuses a hash already held by another record', async () => {
      hashOwner = { id: 't2' };
      await expect(confirm()).rejects.toThrow('already used');
      expect(updateHash).not.toHaveBeenCalled();
    });

    it('refuses to change the hash once creation is confirmed', async () => {
      Object.assign(txRecord, { status: 'confirmed', tx_hash: `0x${'3'.repeat(64)}` });
      await expect(confirm()).rejects.toThrow('already confirmed');
    });

    it('allows a retry and a replaced pending hash', async () => {
      txRecord.tx_hash = TX;
      await confirm();
      txRecord.tx_hash = `0x${'3'.repeat(64)}`;
      await confirm();
      expect(updateHash).toHaveBeenCalledTimes(2);
    });
  });
});
