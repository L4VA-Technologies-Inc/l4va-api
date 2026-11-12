import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';

import { EvmContributionCapsService } from './evm-contribution-caps.service';
import { EvmAssetKindOnchain } from './vault.abi';

import { AssetsWhitelistEntity } from '@/database/assetsWhitelist.entity';
import { EvmContribution, EvmContributionRowStatus } from '@/database/evm-contribution.entity';
import { Transaction } from '@/database/transaction.entity';
import { VaultStatus } from '@/types/vault.types';

type Fn = (...args: any[]) => any;

const NFT = '0x00000000000000000000000000000000000000c1';
const USDC = '0x00000000000000000000000000000000000000d2';

interface Row {
  id: string;
  transaction_id: string;
  kind: EvmAssetKindOnchain;
  asset: string;
  amount: string;
  status: EvmContributionRowStatus;
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function build(opts: {
  rows: Row[];
  /** Other contribute transactions with a reservation (what reservedUsage's query returns). */
  reservedTxs?: Array<{ id: string; metadata: unknown }>;
  whitelist: Array<{ policy_id: string; asset_count_cap_max: number }>;
}) {
  const contribs = {
    find: jest.fn<Fn>(async ({ where }: any) =>
      opts.rows.filter(r => {
        if (where.status && r.status !== where.status) return false;
        if (where.transaction_id) {
          const ids: string[] = where.transaction_id._value ?? [where.transaction_id];
          if (!ids.includes(r.transaction_id)) return false;
        }
        return true;
      })
    ),
  };
  const metadataWrites: any[] = [];
  const qb: Record<string, Fn> = {};
  for (const m of ['where', 'andWhere']) qb[m] = () => qb;
  qb.getMany = async () => opts.reservedTxs ?? [];
  const txRepo = {
    createQueryBuilder: jest.fn<Fn>(() => qb),
    findOne: jest.fn<Fn>(async () => ({ id: 'tx-me', metadata: [{ policyId: NFT }] })),
    update: jest.fn<Fn>(async (_w: any, set: any) => metadataWrites.push(set.metadata)),
  };
  const em = {
    query: jest.fn<Fn>(async () => undefined),
    getRepository: (entity: unknown) => {
      if (entity === EvmContribution) return contribs;
      if (entity === Transaction) return txRepo;
      if (entity === AssetsWhitelistEntity) return { find: async () => opts.whitelist };
      throw new Error('unexpected repository');
    },
  };
  const dataSource = { transaction: jest.fn<Fn>(async (cb: Fn) => cb(em)) };
  const contractReader = { publicClient: { readContract: jest.fn<Fn>(async () => 6) } };
  const service = new EvmContributionCapsService(
    contribs as any,
    txRepo as any,
    dataSource as any,
    contractReader as any
  );
  return { service, em, metadataWrites };
}

const row = (
  id: string,
  tx: string,
  kind: EvmAssetKindOnchain,
  asset: string,
  amount: string,
  refunded = false
): Row => ({
  id,
  transaction_id: tx,
  kind,
  asset,
  amount,
  status: refunded ? EvmContributionRowStatus.refunded : EvmContributionRowStatus.active,
});

describe('EvmContributionCapsService', () => {
  it('counts on-chain contributions that were not refunded, ERC-20 by its on-chain decimals, ignoring ETH', async () => {
    const { service } = build({
      rows: [
        row('c1', 't1', EvmAssetKindOnchain.ERC721, NFT, '1'),
        row('c2', 't1', EvmAssetKindOnchain.ERC721, NFT, '1'),
        row('c3', 't2', EvmAssetKindOnchain.ERC721, NFT, '1', true), // cancelled: no longer held
        row('c4', 't2', EvmAssetKindOnchain.ERC20, USDC, '2500000'),
        row('c5', 't3', EvmAssetKindOnchain.Native, '0x' + '00'.repeat(20), '1000'),
      ],
      whitelist: [],
    });
    const usage = await service.onChainUsage('v1');
    expect(usage.perAsset.get(NFT)).toBe(2);
    expect(usage.perAsset.get(USDC)).toBe(2.5);
    expect(usage.contributionCount).toBe(3);
  });

  it('refuses signatures that would go over a cap counting other unexpired, unused signatures', async () => {
    const { service, metadataWrites } = build({
      rows: [
        row('c1', 't1', EvmAssetKindOnchain.ERC721, NFT, '1'),
        // t2 reserved 2 NFTs and has contributed 1 of them: 1 still outstanding
        row('c2', 't2', EvmAssetKindOnchain.ERC721, NFT, '1'),
      ],
      reservedTxs: [{ id: 't2', metadata: { evmCapsReserved: { [NFT]: 2 } } }],
      whitelist: [{ policy_id: NFT, asset_count_cap_max: 3 }],
    });
    // on-chain 2 + outstanding 1 + this 1 = 4 > 3
    await expect(
      service.reserveForTransaction(
        { id: 'v1', vault_status: VaultStatus.contribution, max_contribute_assets: 0 },
        'tx-me',
        [{ kind: EvmAssetKindOnchain.ERC721, asset: NFT, amount: '1' }],
        2_000_000_000
      )
    ).rejects.toThrow(BadRequestException);
    expect(metadataWrites).toHaveLength(0);
  });

  it('reserves when there is room and records the reservation on the transaction', async () => {
    const { service, em, metadataWrites } = build({
      rows: [row('c1', 't1', EvmAssetKindOnchain.ERC721, NFT, '1')],
      whitelist: [{ policy_id: NFT, asset_count_cap_max: 3 }],
    });
    await service.reserveForTransaction(
      { id: 'v1', vault_status: VaultStatus.contribution, max_contribute_assets: 0 },
      'tx-me',
      [
        { kind: EvmAssetKindOnchain.ERC721, asset: NFT, amount: '1' },
        { kind: EvmAssetKindOnchain.ERC721, asset: NFT, amount: '1' },
      ],
      2_000_000_000
    );
    expect(em.query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext($1))', ['contribution-caps:v1']);
    expect(metadataWrites[0].evmCapsReserved).toEqual({ [NFT]: 2 });
    expect(metadataWrites[0].evmCapsDeadline).toBe(2_000_000_000);
    expect(metadataWrites[0].assets).toEqual([{ policyId: NFT }]); // array metadata kept under `assets`
  });

  it('a repeated prepare does not count its own landed contributions twice', async () => {
    const { service } = build({
      rows: [
        row('c1', 't1', EvmAssetKindOnchain.ERC721, NFT, '1'),
        row('c2', 'tx-me', EvmAssetKindOnchain.ERC721, NFT, '1'), // already contributed by this tx
      ],
      whitelist: [{ policy_id: NFT, asset_count_cap_max: 2 }],
    });
    await expect(
      service.reserveForTransaction(
        { id: 'v1', vault_status: VaultStatus.contribution, max_contribute_assets: 0 },
        'tx-me',
        [{ kind: EvmAssetKindOnchain.ERC721, asset: NFT, amount: '1' }],
        2_000_000_000
      )
    ).resolves.toBeUndefined();
  });

  it("enforces the vault's max_contribute_assets in the contribution phase only", () => {
    const { service } = build({ rows: [], whitelist: [] });
    const usage = { perAsset: new Map([[NFT, 4]]), total: 4, contributionCount: 4 };
    const adding = new Map([[NFT, 2]]);
    expect(() =>
      service.assertWithinCaps(
        { vault_status: VaultStatus.contribution, max_contribute_assets: 5 },
        [],
        usage,
        adding,
        2
      )
    ).toThrow(/maximum capacity of 5/);
    expect(() =>
      service.assertWithinCaps({ vault_status: VaultStatus.expansion, max_contribute_assets: 5 }, [], usage, adding, 2)
    ).not.toThrow();
  });
});
