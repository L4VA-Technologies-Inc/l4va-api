import { getAddressDetails, Lucid, type LucidEvolution, type Network } from '@lucid-evolution/lucid';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { createLucidBlockfrostProvider, lucidNetworkFromCardanoEnv } from '@/common/cardano/blockfrost-lucid';
import { StakingStatus, TokenStakingPosition } from '@/database/tokenStakingPosition.entity';
import { Transaction } from '@/database/transaction.entity';
import { tryDecodeStakeDatum } from '@/modules/stake/stake-datum';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

type StakeKey = `${string}:${number}`;
type StakeTxHashKey = `tx:${string}`;

/** All transaction types that create a new stake box — their output UTxO can be directly unstaked. */
const STAKE_LIKE_TYPES = [TransactionType.stake, TransactionType.harvest, TransactionType.compound];

/**
 * Detects direct (off-platform) stake exits by reconciling DB stake/harvest/compound records
 * with actual UTxOs currently present at the staking contract address.
 *
 * If a DB-confirmed stake-like tx no longer has its output UTxO on-chain, and that UTxO was
 * not legitimately consumed by a subsequent platform harvest/compound, we treat it as an
 * "unstake confirmed" performed outside the backend (no admin-funded reward).
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
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(TokenStakingPosition)
    private readonly tokenStakingPositionRepository: Repository<TokenStakingPosition>
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

  /**
   * Closes all ACTIVE positions that were created by the given stake-like transaction.
   * Called when we detect that the transaction's output boxes are no longer on-chain
   * (direct off-platform unstake).
   */
  private async closePositionsForTransaction(stakeTx: Transaction): Promise<void> {
    try {
      const positions = await this.tokenStakingPositionRepository.find({
        where: { stake_tx_id: stakeTx.id, status: StakingStatus.ACTIVE },
      });

      if (positions.length === 0) return;

      for (const position of positions) {
        await this.tokenStakingPositionRepository.save({
          ...position,
          status: StakingStatus.CLOSED,
        });
      }

      this.logger.log(
        `closePositionsForTransaction: closed ${positions.length} position(s) for tx=${stakeTx.id} user=${stakeTx.user_id}`
      );
    } catch (err) {
      this.logger.error(`closePositionsForTransaction: failed for tx=${stakeTx.id} user=${stakeTx.user_id}`, err);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async reconcileStakes(): Promise<void> {
    const startedAt = Date.now();

    const allStakeLike = await this.transactionRepository.find({
      where: { type: In(STAKE_LIKE_TYPES), status: TransactionStatus.confirmed },
      select: ['id', 'user_id', 'utxo_input', 'utxo_output', 'tx_hash', 'metadata', 'created_at'],
    });

    const openStakes = allStakeLike.filter(tx => {
      const stakedAt = Number(tx.metadata?.staked_at);
      const alreadyClosed = Boolean(tx.metadata?.direct_unstake_detected_at || tx.metadata?.closed_at);
      return Number.isFinite(stakedAt) && stakedAt > 0 && !alreadyClosed;
    });

    if (openStakes.length === 0) {
      this.logger.log(`reconcileStakes: no open confirmed stake-like txs to reconcile`);
      return;
    }

    // Build a set of UTxO txHashes legitimately consumed by platform harvest/compound.
    const knownConsumedTxHashes = new Set<string>();
    for (const tx of allStakeLike) {
      if (tx.type !== TransactionType.harvest && tx.type !== TransactionType.compound) continue;
      const utxos: Array<{ txHash?: string }> = Array.isArray(tx.metadata?.utxos) ? tx.metadata.utxos : [];
      for (const u of utxos) {
        if (u.txHash) knownConsumedTxHashes.add(u.txHash);
      }
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

      // Primary check: by the on-chain tx hash that created this stake box.
      if (stakeTx.tx_hash) {
        const txKey = StakeReconciliationService.stakeTxHashKey(stakeTx.tx_hash);
        if (onChainByTxHash.has(txKey)) continue; // still on-chain
        if (knownConsumedTxHashes.has(stakeTx.tx_hash)) continue; // consumed by platform harvest/compound
      } else {
        // Fallback for legacy rows without tx_hash.
        const key = StakeReconciliationService.stakeKey(ownerHash, stakedAt);
        if (onChainByOwnerAndTime.has(key)) continue;
      }

      // Mark the stake tx as direct-unstaked (idempotent guard).
      const directUnstakeMetadata = {
        ...(stakeTx.metadata ?? {}),
        direct_unstake_detected_at: nowIso,
        direct_unstake_reason: 'utxo_missing_at_contract',
      };

      const updateResult = await this.transactionRepository
        .createQueryBuilder()
        .update(Transaction)
        .set({ metadata: () => ':directUnstakeMetadata::jsonb' })
        .where('id = :id', { id: stakeTx.id })
        .andWhere("(metadata IS NULL OR metadata->>'direct_unstake_detected_at' IS NULL)")
        .setParameter('directUnstakeMetadata', JSON.stringify(directUnstakeMetadata))
        .execute();

      if (!updateResult.affected) continue; // another worker already reconciled this

      // Insert a synthetic unstake record for history/audit.
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

      await this.closePositionsForTransaction(stakeTx);

      closedCount++;
    }

    const elapsedMs = Date.now() - startedAt;
    this.logger.log(
      `reconcileStakes: scanned=${openStakes.length}, closed=${closedCount}, skipped=${skippedCount}, ` +
        `onchainUtxos=${scriptUtxos.length}, elapsedMs=${elapsedMs}`
    );
  }
}
