import { describe, expect, it, jest } from '@jest/globals';
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from 'viem';

import { deriveContributionNonce } from './evm-contribution-nonce';
import { EvmVaultEventReconciler, type VaultLogInput } from './evm-vault-event-reconciler.service';
import { EvmAssetKindOnchain, VAULT_ABI } from './vault.abi';

import { AssetType } from '@/types/asset.types';
import { RewardActivityType } from '@/types/rewards.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';
import { VaultStatus } from '@/types/vault.types';

// Injected as a mock below; its own `src/...` imports do not resolve under jest.
jest.mock('../offchain-tx/transactions.service', () => ({ TransactionsService: class {} }));

type Fn = (...args: any[]) => any;

const VAULT: Address = '0x00000000000000000000000000000000000000aa';
const NFT: Address = '0x00000000000000000000000000000000000000c1';
const ALICE: Address = '0x000000000000000000000000000000000000a11c';
const MALLORY: Address = '0x0000000000000000000000000000000000000bad';
const TX_HASH: Hex = `0x${'11'.repeat(32)}`;

function contributionLog(o: {
  id: bigint;
  contributor: Address;
  kind: EvmAssetKindOnchain;
  asset: Address;
  tokenId: bigint;
  amount: bigint;
}): VaultLogInput {
  const topics = encodeEventTopics({
    abi: VAULT_ABI,
    eventName: 'ContributionMade',
    args: { contributionId: o.id, cycleId: 1n, contributor: o.contributor },
  });
  const data = encodeAbiParameters(
    [{ type: 'uint8' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }],
    [o.kind, o.asset, o.tokenId, o.amount, `0x${'00'.repeat(32)}`]
  );
  return { address: VAULT, topics: topics as string[], data, txHash: TX_HASH, blockNumber: 100, logIndex: 0 };
}

function qb(result: { one?: unknown; many?: unknown[] }) {
  const b: Record<string, Fn> = {};
  for (const m of ['where', 'andWhere', 'leftJoinAndSelect', 'select', 'orderBy']) b[m] = () => b;
  b.getOne = async () => result.one ?? null;
  b.getMany = async () => result.many ?? [];
  return b;
}

interface Tx {
  id: string;
  type: TransactionType;
  tx_hash: string | null;
  status: TransactionStatus;
  metadata: unknown;
  is_expansion?: boolean;
  user: { address: string };
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function build(opts: {
  /** Transaction holding TX_HASH (what /confirm stored). */
  byHash: Tx | null;
  /** Transactions of the event's contributor (nonce adoption candidates). */
  candidates?: Tx[];
  authNonce: bigint;
  assetRows: Record<string, Array<{ id: string; type: AssetType; policy_id: string; asset_id: string }>>;
  existing?: { id: string; transaction_id: string; asset_id: string | null } & Record<string, unknown>;
  vaultStatus?: VaultStatus;
}) {
  const vault = { id: 'v1', contract_address: VAULT, vault_status: opts.vaultStatus ?? VaultStatus.contribution };
  const statusUpdates: Array<{ where: any; set: any }> = [];
  const inserted: any[] = [];
  const all = [opts.byHash, ...(opts.candidates ?? [])].filter(Boolean) as Tx[];

  const transactionsRepository = {
    findOne: jest.fn<Fn>(async ({ where }: any) =>
      where.tx_hash ? (opts.byHash?.tx_hash === where.tx_hash ? opts.byHash : null) : all.find(t => t.id === where.id)
    ),
    createQueryBuilder: jest.fn<Fn>(() => qb({ one: null, many: opts.candidates ?? [] })),
    update: jest.fn<Fn>(async (where: any, set: any) => {
      statusUpdates.push({ where, set });
      return { affected: 1 };
    }),
  };
  const contribsRepository = {
    findOne: jest.fn<Fn>(async () => opts.existing ?? null),
    insert: jest.fn<Fn>(async (row: any) => inserted.push(row)),
    find: jest.fn<Fn>(async () => []),
  };
  const assetsRepository = {
    count: jest.fn<Fn>(async ({ where }: any) => (opts.assetRows[where.transaction.id] ?? []).length),
    find: jest.fn<Fn>(async ({ where }: any) => opts.assetRows[where.transaction.id] ?? []),
  };
  const vaultsRepository = { createQueryBuilder: jest.fn<Fn>(() => qb({ many: [vault] })) };
  const contractReader = {
    getContribution: jest.fn<Fn>(async () => ({ authNonce: opts.authNonce.toString() })),
    publicClient: { getBlock: jest.fn<Fn>(async () => ({ timestamp: 0n })) },
  };
  const transactionsService = {
    lockAssetsForTransaction: jest.fn<Fn>(async () => 1),
    createAssets: jest.fn<Fn>(async () => ({ success: true })),
  };
  const rewardEventProducer = { indexEvent: jest.fn<Fn>(async () => ({ id: 'e1' })) };

  const reconciler = new EvmVaultEventReconciler(
    vaultsRepository as any,
    contribsRepository as any,
    {} as any,
    {} as any,
    transactionsRepository as any,
    assetsRepository as any,
    {} as any,
    {} as any,
    {} as any,
    contractReader as any,
    {} as any,
    transactionsService as any,
    { sendAlert: jest.fn() } as any,
    rewardEventProducer as any
  );
  return { reconciler, statusUpdates, inserted, transactionsService, rewardEventProducer };
}

const confirmedIds = (updates: Array<{ where: any; set: any }>): string[] =>
  updates.filter(u => u.set.status === TransactionStatus.confirmed).map(u => u.where.id);

describe('EvmVaultEventReconciler — ContributionMade confirms only the transaction that signed it', () => {
  it('a contribution signed for the transaction: confirmed, its asset locked, one reward unit', async () => {
    const tx: Tx = {
      id: 'tx-alice',
      type: TransactionType.contribute,
      tx_hash: TX_HASH,
      status: TransactionStatus.submitted,
      metadata: {},
      user: { address: ALICE },
    };
    const { reconciler, statusUpdates, inserted, transactionsService, rewardEventProducer } = build({
      byHash: tx,
      authNonce: deriveContributionNonce('tx-alice', 1),
      assetRows: {
        'tx-alice': [
          { id: 'a0', type: AssetType.NFT, policy_id: NFT, asset_id: '7' },
          { id: 'a1', type: AssetType.NFT, policy_id: NFT, asset_id: '8' },
        ],
      },
    });

    const stats = await reconciler.reconcileLogs([
      contributionLog({
        id: 5n,
        contributor: ALICE,
        kind: EvmAssetKindOnchain.ERC721,
        asset: NFT,
        tokenId: 8n,
        amount: 1n,
      }),
    ]);

    expect(stats.errors).toBe(0);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].transaction_id).toBe('tx-alice');
    expect(inserted[0].asset_id).toBe('a1'); // the NFT with token id 8, not the first row of the collection
    expect(confirmedIds(statusUpdates)).toEqual(['tx-alice']);
    expect(transactionsService.lockAssetsForTransaction).toHaveBeenCalledWith('tx-alice', ['a1']);
    expect(rewardEventProducer.indexEvent).toHaveBeenCalledTimes(1);
    const reward = rewardEventProducer.indexEvent.mock.calls[0][0] as any;
    expect(reward.eventType).toBe(RewardActivityType.ASSET_CONTRIBUTION);
    expect(reward.units).toBe(1);
    expect(reward.idempotencyKey).toBe(`${RewardActivityType.ASSET_CONTRIBUTION}:${TX_HASH}:5`);
  });

  it('a hash claimed by another transaction via /confirm: bound by nonce to the real one, the claimer gets nothing', async () => {
    // Mallory's transaction holds Alice's hash (sent to /confirm), but the contribution's nonce was
    // signed for Alice's transaction.
    const mallory: Tx = {
      id: 'tx-mallory',
      type: TransactionType.acquire,
      tx_hash: TX_HASH,
      status: TransactionStatus.submitted,
      metadata: {},
      user: { address: MALLORY },
    };
    const alice: Tx = {
      id: 'tx-alice',
      type: TransactionType.acquire,
      tx_hash: TX_HASH,
      status: TransactionStatus.submitted,
      metadata: {},
      user: { address: ALICE },
    };
    const { reconciler, statusUpdates, inserted, rewardEventProducer } = build({
      byHash: mallory,
      candidates: [alice],
      authNonce: deriveContributionNonce('tx-alice', 0),
      assetRows: {
        'tx-alice': [{ id: 'eth-a', type: AssetType.ETH, policy_id: '0x' + '00'.repeat(20), asset_id: 'eth' }],
      },
    });

    const stats = await reconciler.reconcileLogs([
      contributionLog({
        id: 9n,
        contributor: ALICE,
        kind: EvmAssetKindOnchain.Native,
        asset: '0x0000000000000000000000000000000000000000',
        tokenId: 0n,
        amount: 10n ** 18n,
      }),
    ]);

    expect(stats.errors).toBe(0);
    expect(inserted[0].transaction_id).toBe('tx-alice');
    expect(confirmedIds(statusUpdates)).toEqual(['tx-alice']);
    const reward = rewardEventProducer.indexEvent.mock.calls[0][0] as any;
    expect(reward.walletAddress).toBe(ALICE);
    expect(reward.eventType).toBe(RewardActivityType.TOKEN_ACQUIRE);
    expect(reward.units).toBe(1e18); // the ETH that landed, not the amount the request asked for
  });

  it('a redelivered contribution re-applies status and lock but not the reward', async () => {
    const tx: Tx = {
      id: 'tx-alice',
      type: TransactionType.contribute,
      tx_hash: TX_HASH,
      status: TransactionStatus.confirmed,
      metadata: {},
      user: { address: ALICE },
    };
    const log = contributionLog({
      id: 5n,
      contributor: ALICE,
      kind: EvmAssetKindOnchain.ERC721,
      asset: NFT,
      tokenId: 8n,
      amount: 1n,
    });
    const { reconciler, transactionsService, rewardEventProducer } = build({
      byHash: tx,
      authNonce: deriveContributionNonce('tx-alice', 0),
      assetRows: {},
      existing: {
        id: 'c1',
        transaction_id: 'tx-alice',
        asset_id: 'a1',
        contributor: ALICE.toLowerCase(),
        kind: EvmAssetKindOnchain.ERC721,
        asset: NFT.toLowerCase(),
        token_id: '8',
        amount: '1',
        cycle_id: '1',
      },
    });

    const stats = await reconciler.reconcileLogs([log]);

    expect(stats.errors).toBe(0);
    expect(transactionsService.lockAssetsForTransaction).toHaveBeenCalledWith('tx-alice', ['a1']);
    expect(rewardEventProducer.indexEvent).not.toHaveBeenCalled();
  });
});
