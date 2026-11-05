import type { Repository } from 'typeorm';

import { Transaction } from '@/database/transaction.entity';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

/**
 * Acquire-expansion contribution signatures that can still be used on-chain: issued (the
 * transaction stores `metadata.evmAuthDeadline` / `evmAuthWei`), not yet landed (status not
 * confirmed / failed / refunded) and not expired. Until one expires its ETH may still arrive,
 * so it counts against the expansion maximum and the window must not close before it.
 */
function outstandingQuery(repo: Repository<Transaction>, vaultId: string, excludeTxId?: string) {
  const qb = repo
    .createQueryBuilder('tx')
    .where('tx.vault_id = :vaultId', { vaultId })
    .andWhere('tx.type = :type', { type: TransactionType.acquire })
    .andWhere('tx.status IN (:...statuses)', {
      statuses: [TransactionStatus.created, TransactionStatus.pending, TransactionStatus.submitted],
    })
    .andWhere("(tx.metadata->>'evmAuthDeadline')::bigint > :now", { now: Math.floor(Date.now() / 1000) });
  if (excludeTxId) qb.andWhere('tx.id != :excludeTxId', { excludeTxId });
  return qb;
}

/** ETH (wei) reserved by other still-valid acquire-expansion signatures of the vault. */
export async function sumOutstandingAcquireSignatures(
  repo: Repository<Transaction>,
  vaultId: string,
  excludeTxId?: string
): Promise<bigint> {
  const rows = await outstandingQuery(repo, vaultId, excludeTxId)
    .select("tx.metadata->>'evmAuthWei'", 'wei')
    .getRawMany<{ wei: string | null }>();
  return rows.reduce((sum, r) => sum + (r.wei && /^\d+$/.test(r.wei) ? BigInt(r.wei) : 0n), 0n);
}

/** Latest deadline (unix seconds) among still-valid acquire-expansion signatures, or null. */
export async function latestOutstandingAcquireDeadline(
  repo: Repository<Transaction>,
  vaultId: string
): Promise<number | null> {
  const row = await outstandingQuery(repo, vaultId)
    .select("MAX((tx.metadata->>'evmAuthDeadline')::bigint)", 'deadline')
    .getRawOne<{ deadline: string | null }>();
  return row?.deadline ? Number(row.deadline) : null;
}
