import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { parseAbiItem, type Address } from 'viem';

import { bigintDecimalAdjustedToNumber } from '../../phase-management/contribution/contribution-asset.utils';

import { EvmContractReader } from './evm-contract-reader.service';
import { EvmAssetKindOnchain } from './vault.abi';

import { AssetsWhitelistEntity } from '@/database/assetsWhitelist.entity';
import { EvmContribution, EvmContributionRowStatus } from '@/database/evm-contribution.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';
import { VaultStatus } from '@/types/vault.types';

const ERC20_DECIMALS_ABI = [parseAbiItem('function decimals() view returns (uint8)')] as const;

/** One asset as the contract sees it: what a contribution authorization signs, or what landed. */
export interface EvmCapAsset {
  /** EvmAssetKindOnchain value. */
  kind: number;
  /** Token contract, any case. Ignored for Native. */
  asset: string;
  /** Base units (ERC-20), unit count (ERC-1155) or 1 (ERC-721). */
  amount: string | bigint;
}

/** Whole units per asset contract (lowercase), the scale the whitelist caps are written in. */
export interface EvmCapUsage {
  perAsset: Map<string, number>;
  total: number;
  /** Non-native contributions counted (on-chain rows only). */
  contributionCount: number;
}

/** Stored on a contribute Transaction once its signatures are issued (see reserveForTransaction). */
interface CapsReservationMeta {
  evmCapsDeadline?: number;
  evmCapsReserved?: Record<string, number>;
}

/**
 * Asset caps for EVM vault contributions (vault `max_contribute_assets` and each whitelist
 * entry's `asset_count_cap_max` / `asset_count_cap_min`).
 *
 * Caps are counted from what the vault actually holds: on-chain contributions that were not
 * refunded (`evm_contributions`), plus contribution signatures that are issued, unexpired and not
 * used yet. DB `Asset` rows are not used: a user can create them without contributing, and a
 * cancelled contribution keeps its row (status RELEASED).
 *
 * The gate is `reserveForTransaction`, called when the signatures are issued: a signature is the
 * only way to contribute, so nothing over a cap can land on-chain and fail the vault at its
 * snapshot (`validateEvmAssetWhitelistThresholds`).
 */
@Injectable()
export class EvmContributionCapsService {
  private readonly decimalsCache = new Map<string, number>();

  constructor(
    @InjectRepository(EvmContribution)
    private readonly contribsRepository: Repository<EvmContribution>,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    private readonly dataSource: DataSource,
    private readonly contractReader: EvmContractReader
  ) {}

  /**
   * Whole units one asset counts for against the caps. NFTs (ERC-721 and ERC-1155) count 1 per
   * contribution, as everywhere else in the cap checks; ERC-20 uses the token's on-chain decimals.
   */
  async quantityOf(a: EvmCapAsset): Promise<number> {
    switch (Number(a.kind)) {
      case EvmAssetKindOnchain.ERC721:
      case EvmAssetKindOnchain.ERC1155:
        return 1;
      case EvmAssetKindOnchain.ERC20:
        return bigintDecimalAdjustedToNumber(BigInt(a.amount), await this.erc20Decimals(a.asset));
      default:
        return 0; // Native ETH is not a whitelisted asset
    }
  }

  /** Active (not refunded) on-chain contributions of the vault, across all cycles. */
  async onChainUsage(vaultId: string, em?: EntityManager): Promise<EvmCapUsage> {
    const repo = em ? em.getRepository(EvmContribution) : this.contribsRepository;
    const rows = await repo.find({
      where: { vault_id: vaultId, status: EvmContributionRowStatus.active },
      select: ['id', 'kind', 'asset', 'amount'],
    });
    const usage: EvmCapUsage = {
      perAsset: new Map(),
      total: 0,
      contributionCount: 0,
    };
    for (const r of rows) {
      if (Number(r.kind) === EvmAssetKindOnchain.Native) continue;
      const qty = await this.quantityOf({
        kind: r.kind,
        asset: r.asset,
        amount: r.amount,
      });
      add(usage.perAsset, r.asset, qty);
      usage.total += qty;
      usage.contributionCount += 1;
    }
    return usage;
  }

  /**
   * Units held by issued, unexpired signatures that have not landed yet. Each contribute
   * Transaction reserves its assets when its signatures are issued; whatever of it already landed
   * on-chain (in any status — a used signature cannot be used again) is subtracted, because the
   * on-chain row counts it.
   */
  async reservedUsage(vaultId: string, excludeTxId?: string, em?: EntityManager): Promise<EvmCapUsage> {
    const txRepo = em ? em.getRepository(Transaction) : this.transactionRepository;
    const qb = txRepo
      .createQueryBuilder('tx')
      .where('tx.vault_id = :vaultId', { vaultId })
      .andWhere('tx.type = :type', { type: TransactionType.contribute })
      .andWhere('tx.status NOT IN (:...done)', {
        done: [TransactionStatus.failed, TransactionStatus.refunded],
      })
      .andWhere("(tx.metadata->>'evmCapsDeadline')::bigint > :now", {
        now: Math.floor(Date.now() / 1000),
      });
    if (excludeTxId) qb.andWhere('tx.id != :excludeTxId', { excludeTxId });
    const txs = await qb.getMany();

    const usage: EvmCapUsage = {
      perAsset: new Map(),
      total: 0,
      contributionCount: 0,
    };
    if (txs.length === 0) return usage;

    const contribRepo = em ? em.getRepository(EvmContribution) : this.contribsRepository;
    const landed = await contribRepo.find({
      where: { transaction_id: In(txs.map(t => t.id)) },
      select: ['id', 'transaction_id', 'kind', 'asset', 'amount'],
    });
    const landedByTx = new Map<string, Map<string, number>>();
    for (const r of landed) {
      if (Number(r.kind) === EvmAssetKindOnchain.Native) continue;
      const m = landedByTx.get(r.transaction_id) ?? new Map<string, number>();
      add(
        m,
        r.asset,
        await this.quantityOf({
          kind: r.kind,
          asset: r.asset,
          amount: r.amount,
        })
      );
      landedByTx.set(r.transaction_id, m);
    }

    for (const tx of txs) {
      const reserved = (tx.metadata as CapsReservationMeta | null)?.evmCapsReserved ?? {};
      const used = landedByTx.get(tx.id);
      for (const [asset, qty] of Object.entries(reserved)) {
        const outstanding = Math.max(0, Number(qty) - (used?.get(asset.toLowerCase()) ?? 0));
        if (outstanding > 0) {
          add(usage.perAsset, asset, outstanding);
          usage.total += outstanding;
        }
      }
    }
    return usage;
  }

  /** On-chain usage plus outstanding signatures of other transactions. */
  async currentUsage(vaultId: string, excludeTxId?: string, em?: EntityManager): Promise<EvmCapUsage> {
    const [onChain, reserved] = await Promise.all([
      this.onChainUsage(vaultId, em),
      this.reservedUsage(vaultId, excludeTxId, em),
    ]);
    for (const [asset, qty] of reserved.perAsset) add(onChain.perAsset, asset, qty);
    onChain.total += reserved.total;
    return onChain;
  }

  /**
   * Reserve cap room for a contribute Transaction's assets before its signatures are returned.
   * Serialised per vault with an advisory lock, so two concurrent requests cannot both take the
   * last room. Throws BadRequestException when a cap would be exceeded; the caller then does not
   * hand out the signatures.
   */
  async reserveForTransaction(
    vault: Pick<Vault, 'id' | 'vault_status' | 'max_contribute_assets'>,
    transactionId: string,
    assets: EvmCapAsset[],
    deadline: number
  ): Promise<void> {
    const adding = new Map<string, number>();
    let addingTotal = 0;
    for (const a of assets) {
      const qty = await this.quantityOf(a);
      if (qty === 0) continue;
      add(adding, a.asset, qty);
      addingTotal += qty;
    }

    await this.dataSource.transaction(async em => {
      await em.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`contribution-caps:${vault.id}`]);

      const whitelist = await em.getRepository(AssetsWhitelistEntity).find({ where: { vault: { id: vault.id } } });
      const usage = await this.currentUsage(vault.id, transactionId, em);

      // A repeated prepare: what this transaction already contributed is in the on-chain usage, and
      // those signatures are used, so only the rest is new.
      const ownLanded = await em.getRepository(EvmContribution).find({
        where: { transaction_id: transactionId },
        select: ['id', 'kind', 'asset', 'amount'],
      });
      const newUnits = new Map(adding);
      let newTotal = addingTotal;
      for (const r of ownLanded) {
        const key = r.asset.toLowerCase();
        const left = newUnits.get(key);
        if (left === undefined) continue;
        const used = Math.min(
          left,
          await this.quantityOf({
            kind: r.kind,
            asset: r.asset,
            amount: r.amount,
          })
        );
        newUnits.set(key, left - used);
        newTotal -= used;
      }
      this.assertWithinCaps(vault, whitelist, usage, newUnits, newTotal);

      const current = await em.getRepository(Transaction).findOne({ where: { id: transactionId } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- jsonb, as in reserveAcquireExpansionSignature
      const meta = (current?.metadata ?? {}) as any;
      const base = Array.isArray(meta) ? { assets: meta } : meta;
      await em.getRepository(Transaction).update(
        { id: transactionId },
        {
          metadata: {
            ...base,
            evmCapsDeadline: deadline,
            evmCapsReserved: Object.fromEntries(adding),
          },
        }
      );
    });
  }

  /**
   * Throws if adding these units breaks a whitelist maximum or, in the contribution phase, the
   * vault's `max_contribute_assets`. Entries without a positive maximum are uncapped.
   */
  assertWithinCaps(
    vault: Pick<Vault, 'vault_status' | 'max_contribute_assets'>,
    whitelist: Pick<AssetsWhitelistEntity, 'policy_id' | 'asset_count_cap_max'>[],
    usage: EvmCapUsage,
    adding: Map<string, number>,
    addingTotal: number
  ): void {
    const exceeded: string[] = [];
    for (const [asset, qty] of adding) {
      const entry = whitelist.find(w => (w.policy_id || '').toLowerCase() === asset);
      const max = Number(entry?.asset_count_cap_max);
      if (!entry || !(max > 0) || qty <= 0) continue;
      const existing = usage.perAsset.get(asset) ?? 0;
      if (existing + qty > max) {
        exceeded.push(`Policy ${entry.policy_id}: has ${existing}, adding ${qty} would exceed max ${max}`);
      }
    }
    if (exceeded.length > 0) {
      throw new BadRequestException(`Policy limits exceeded: ${exceeded.join('; ')}`);
    }

    const maxTotal = Number(vault.max_contribute_assets);
    if (vault.vault_status === VaultStatus.contribution && maxTotal > 0 && usage.total + addingTotal > maxTotal) {
      throw new BadRequestException(
        `Adding ${addingTotal} assets would exceed the vault's maximum capacity of ${maxTotal}. ` +
          `The vault currently has ${usage.total} assets, including contributions in progress.`
      );
    }
  }

  private async erc20Decimals(asset: string): Promise<number> {
    const key = asset.toLowerCase();
    const cached = this.decimalsCache.get(key);
    if (cached !== undefined) return cached;
    const decimals = Number(
      await this.contractReader.publicClient.readContract({
        address: key as Address,
        abi: ERC20_DECIMALS_ABI,
        functionName: 'decimals',
      })
    );
    this.decimalsCache.set(key, decimals);
    return decimals;
  }
}

function add(map: Map<string, number>, asset: string, qty: number): void {
  const key = asset.toLowerCase();
  map.set(key, (map.get(key) ?? 0) + qty);
}
