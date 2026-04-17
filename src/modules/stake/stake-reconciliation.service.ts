import { getAddressDetails, Lucid, type LucidEvolution, type Network } from '@lucid-evolution/lucid';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { createLucidBlockfrostProvider, lucidNetworkFromCardanoEnv } from '@/common/cardano/blockfrost-lucid';
import { Transaction } from '@/database/transaction.entity';
import { tryDecodeStakeDatum } from '@/modules/stake/stake-datum';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

type StakeKey = `${string}:${number}`;
type StakeTxHashKey = `tx:${string}`;

/**
 * Detects direct (off-platform) stake exits by reconciling DB stake records
 * with actual UTxOs currently present at the staking contract address.
 *
 * If a DB-confirmed stake no longer exists on-chain, we treat it as an "unstake confirmed"
 * performed outside the backend (no admin-funded reward).
 */
@Injectable()
export class StakeReconciliationService {
  private readonly logger = new Logger(StakeReconciliationService.name);

  private readonly isMainnet: boolean;
  private readonly network: Network;
  private readonly blockfrostProjectId: string;
  private readonly contractAddress: string;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>
  ) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    this.network = lucidNetworkFromCardanoEnv(this.isMainnet);
    this.blockfrostProjectId = this.configService.getOrThrow<string>('BLOCKFROST_API_KEY');
    this.contractAddress = this.configService.getOrThrow<string>('CONTRACT_ADDRESS');
  }

  private async createLucid(): Promise<LucidEvolution> {
    return await Lucid(createLucidBlockfrostProvider(this.blockfrostProjectId, this.network), this.network);
  }

  private static stakeKey(ownerHash: string, stakedAt: number): StakeKey {
    return `${ownerHash}:${stakedAt}`;
  }

  private static stakeTxHashKey(txHash: string): StakeTxHashKey {
    return `tx:${txHash}`;
  }

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async reconcileStakes(): Promise<void> {
    const startedAt = Date.now();

    const stakes = await this.transactionRepository.find({
      where: { type: TransactionType.stake, status: TransactionStatus.confirmed },
      select: ['id', 'user_id', 'utxo_input', 'utxo_output', 'tx_hash', 'metadata', 'created_at'],
    });

    const openStakes = stakes.filter(tx => {
      const stakedAt = Number(tx.metadata?.staked_at);
      const alreadyClosed = Boolean(tx.metadata?.direct_unstake_detected_at || tx.metadata?.closed_at);
      return Number.isFinite(stakedAt) && stakedAt > 0 && !alreadyClosed;
    });

    if (openStakes.length === 0) {
      this.logger.log(`reconcileStakes: no open confirmed stakes to reconcile`);
      return;
    }

    const lucid = await this.createLucid();
    const scriptUtxos = await lucid.utxosAt(this.contractAddress);

    const onChainByOwnerAndTime = new Set<StakeKey>();
    const onChainByTxHash = new Set<StakeTxHashKey>();
    for (const utxo of scriptUtxos) {
      onChainByTxHash.add(StakeReconciliationService.stakeTxHashKey(utxo.txHash));

      if (!utxo.datum) continue;
      const decoded = tryDecodeStakeDatum(utxo.datum);
      if (!decoded) continue;
      const stakedAt = Number(decoded.staked_at);
      if (!Number.isFinite(stakedAt) || stakedAt <= 0) continue;
      onChainByOwnerAndTime.add(StakeReconciliationService.stakeKey(decoded.owner, stakedAt));
    }

    const nowIso = new Date().toISOString();
    let closedCount = 0;
    let skippedCount = 0;

    for (const stakeTx of openStakes) {
      const stakedAt = Number(stakeTx.metadata?.staked_at);

      const userAddress = stakeTx.utxo_input;
      const { paymentCredential } = getAddressDetails(userAddress);
      const ownerHash = paymentCredential?.hash;

      if (!ownerHash) {
        skippedCount++;
        continue;
      }

      // Primary correlation is by the tx hash that created the stake UTxO.
      // This avoids collisions when multiple stakes share the same staked_at millisecond.
      if (stakeTx.tx_hash) {
        const txKey = StakeReconciliationService.stakeTxHashKey(stakeTx.tx_hash);
        if (onChainByTxHash.has(txKey)) continue;
      } else {
        // Fallback correlation for legacy rows without tx_hash.
        const key = StakeReconciliationService.stakeKey(ownerHash, stakedAt);
        if (onChainByOwnerAndTime.has(key)) continue;
      }

      // Mark the stake as closed off-platform.
      const directUnstakeMetadata = {
        ...(stakeTx.metadata ?? {}),
        direct_unstake_detected_at: nowIso,
        direct_unstake_reason: 'utxo_missing_at_contract',
      };

      // Idempotency across concurrent workers: only the first worker that flips this flag proceeds.
      const updateResult = await this.transactionRepository
        .createQueryBuilder()
        .update(Transaction)
        .set({
          // TypeORM typings for JSONB updates are awkward; use a JSONB cast expression.
          metadata: () => ':directUnstakeMetadata::jsonb',
        })
        .where('id = :id', { id: stakeTx.id })
        .andWhere("(metadata IS NULL OR metadata->>'direct_unstake_detected_at' IS NULL)")
        .setParameter('directUnstakeMetadata', JSON.stringify(directUnstakeMetadata))
        .execute();

      if (!updateResult.affected) {
        // Another worker already reconciled this stake.
        continue;
      }

      // Insert a synthetic "unstake confirmed" record for accounting/history.
      // Amount is set to 0 because we don't know the actual payout (and no admin reward applies).
      const existingSynthetic = await this.transactionRepository
        .createQueryBuilder('tx')
        .where('tx.type = :type', { type: TransactionType.unstake })
        .andWhere('tx.user_id = :userId', { userId: stakeTx.user_id })
        .andWhere(`tx.metadata->>'kind' = :kind`, { kind: 'direct_unstake_detected' })
        .andWhere(`tx.metadata->>'stakeTransactionId' = :stakeTransactionId`, { stakeTransactionId: stakeTx.id })
        .getOne();

      if (!existingSynthetic) {
        await this.transactionRepository.save({
          type: TransactionType.unstake,
          status: TransactionStatus.confirmed,
          user_id: stakeTx.user_id,
          utxo_input: this.contractAddress,
          utxo_output: userAddress,
          amount: 0,
          metadata: {
            kind: 'direct_unstake_detected',
            detectedAt: nowIso,
            stakeTransactionId: stakeTx.id,
            stakeTxHash: stakeTx.tx_hash ?? null,
            staked_at: stakedAt,
          },
        });
      }

      closedCount++;
    }

    const elapsedMs = Date.now() - startedAt;
    this.logger.log(
      `reconcileStakes: scanned=${openStakes.length}, closed=${closedCount}, skipped=${skippedCount}, ` +
        `onchainUtxos=${scriptUtxos.length}, elapsedMs=${elapsedMs}`
    );
  }
}
