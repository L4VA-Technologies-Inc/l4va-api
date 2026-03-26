import { Blockfrost, Lucid } from '@lucid-evolution/lucid';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TransactionsService } from '../../processing-tx/offchain-tx/transactions.service';

import { Proposal } from '@/database/proposal.entity';
import { Transaction } from '@/database/transaction.entity';
import { ProposalStatus } from '@/types/proposal.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

@Injectable()
export class GovernanceRefundService {
  private readonly logger = new Logger(GovernanceRefundService.name);
  private readonly isMainnet: boolean;
  private readonly adminAddress: string;
  private readonly adminSKey: string;

  private isRetrying = false;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(Proposal)
    private readonly proposalRepository: Repository<Proposal>,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    private readonly transactionsService: TransactionsService
  ) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    this.adminAddress = this.configService.get<string>('ADMIN_ADDRESS');
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
  }

  async refundProposalCreationFeeIfNeeded(
    proposalId: string,
    options?: { throwOnFailure?: boolean }
  ): Promise<{ refunded: boolean; txHash?: string }> {
    const throwOnFailure = options?.throwOnFailure ?? false;

    const proposal = await this.proposalRepository.findOne({
      where: { id: proposalId },
      relations: ['creator'],
    });

    if (!proposal) {
      return { refunded: false };
    }

    // Only refund proposals that are either UPCOMING (user deletion) or already REJECTED.
    if (![ProposalStatus.UPCOMING, ProposalStatus.REJECTED].includes(proposal.status)) {
      return { refunded: false };
    }

    const creatorAddress = proposal.creator?.address;
    if (!creatorAddress) {
      if (throwOnFailure) {
        throw new Error('Proposal creator address not found for refund');
      }
      return { refunded: false };
    }

    const paymentTx = await this.transactionRepository
      .createQueryBuilder('tx')
      .where('tx.type = :type', { type: TransactionType.payment })
      .andWhere('tx.vault_id = :vaultId', { vaultId: proposal.vaultId })
      .andWhere('tx.status IN (:...statuses)', {
        statuses: [TransactionStatus.submitted, TransactionStatus.confirmed],
      })
      .andWhere('tx.tx_hash IS NOT NULL')
      .andWhere(`tx.metadata->>'kind' = :kind`, { kind: 'governance_creation_fee' })
      .andWhere(`tx.metadata->>'proposalId' = :proposalId`, { proposalId })
      .getOne();

    const feeAmount = paymentTx?.amount ?? 0;
    if (feeAmount <= 0) {
      return { refunded: false };
    }

    const refundedAt = new Date().toISOString();

    // Idempotency: reuse existing refund record when possible.
    const existingRefundTx = await this.transactionRepository
      .createQueryBuilder('tx')
      .where('tx.type = :type', { type: TransactionType.payment })
      .andWhere('tx.vault_id = :vaultId', { vaultId: proposal.vaultId })
      .andWhere(`tx.metadata->>'kind' = :kind`, { kind: 'governance_creation_fee_refund' })
      .andWhere(`tx.metadata->>'refundOfProposalId' = :proposalId`, { proposalId })
      .getOne();

    if (existingRefundTx) {
      if (
        [TransactionStatus.submitted, TransactionStatus.confirmed].includes(existingRefundTx.status) &&
        existingRefundTx.tx_hash
      ) {
        return { refunded: true, txHash: existingRefundTx.tx_hash };
      }
    }

    let refundTxId: string | undefined;

    try {
      if (existingRefundTx) {
        // Resume/retry using the same DB transaction row to avoid duplicates.
        refundTxId = existingRefundTx.id;
        await this.transactionRepository.update(
          { id: existingRefundTx.id },
          {
            status: TransactionStatus.created,
            metadata: {
              ...(existingRefundTx.metadata || {}),
              kind: 'governance_creation_fee_refund',
              refundOfProposalId: proposalId,
              refundedAt,
              paymentTxHash: paymentTx?.tx_hash,
            } as any,
          }
        );
      } else {
        const refundTx = await this.transactionsService.createTransaction({
          vault_id: proposal.vaultId,
          type: TransactionType.payment,
          assets: [],
          amount: feeAmount,
          userId: proposal.creatorId,
          metadata: {
            kind: 'governance_creation_fee_refund',
            refundOfProposalId: proposalId,
            refundedAt,
            paymentTxHash: paymentTx?.tx_hash,
          },
        });
        refundTxId = refundTx.id;
      }

      const refundTxHash = await this.submitAdminRefundTx({
        proposalId,
        proposalTitle: proposal.title,
        toAddress: creatorAddress,
        lovelaceAmount: feeAmount,
      });

      await this.transactionsService.updateTransactionHash(refundTxId, refundTxHash, {
        kind: 'governance_creation_fee_refund',
        refundOfProposalId: proposalId,
        refundedAt,
        paymentTxHash: paymentTx?.tx_hash,
        refundTxHash,
      });

      return { refunded: true, txHash: refundTxHash };
    } catch (error: any) {
      const message = error?.message || error?.toString?.() || 'Unknown refund error';
      this.logger.error(`Failed to refund proposal ${proposalId}: ${message}`, error?.stack);
      if (refundTxId) {
        await this.transactionRepository.update(
          { id: refundTxId },
          {
            status: TransactionStatus.failed,
            metadata: {
              kind: 'governance_creation_fee_refund',
              refundOfProposalId: proposalId,
              refundedAt,
              paymentTxHash: paymentTx?.tx_hash,
              refundError: {
                message,
                timestamp: new Date().toISOString(),
              },
            } as any,
          }
        );
      }

      if (throwOnFailure) {
        throw new Error(message);
      }

      return { refunded: false };
    }
  }

  private async submitAdminRefundTx(config: {
    proposalId: string;
    proposalTitle?: string;
    toAddress: string;
    lovelaceAmount: number;
  }): Promise<string> {
    const { proposalId, proposalTitle, toAddress, lovelaceAmount } = config;

    const network = this.isMainnet ? 'Mainnet' : 'Preprod';
    const lucid = await Lucid(
      new Blockfrost(
        `https://cardano-${network.toLowerCase()}.blockfrost.io/api/v0`,
        this.configService.get<string>('BLOCKFROST_API_KEY')
      ),
      network
    );

    // Select admin wallet utxos so Lucid can build a transaction spending from admin.
    const adminUtxos = await lucid.utxosAt(this.adminAddress);
    lucid.selectWallet.fromAddress(this.adminAddress, adminUtxos);

    // Refund is ADA-only and the receiver gets exactly `lovelaceAmount`.
    const metadataMessage = this.formatRefundMetadataMessage(proposalId, proposalTitle);
    const tx = await lucid
      .newTx()
      .pay.ToAddress(toAddress, { lovelace: BigInt(lovelaceAmount) })
      .attachMetadata(674, metadataMessage)
      .complete({ changeAddress: this.adminAddress });

    const signedTx = await tx.sign.withPrivateKey(this.adminSKey).complete();
    return await signedTx.submit();
  }

  private formatRefundMetadataMessage(proposalId: string, proposalTitle?: string): { msg: string[] } {
    const proposalLabel = proposalTitle?.trim() || proposalId;
    const raw = `L4VA: Governance fee refund for proposal ${proposalLabel}`;

    const chunks: string[] = [];
    let remaining = raw;
    while (remaining.length > 0) {
      if (remaining.length <= 64) {
        chunks.push(remaining);
        break;
      }

      let breakPoint = 64;
      const searchSpace = remaining.slice(0, 65);
      const lastSpace = searchSpace.lastIndexOf(' ');
      if (lastSpace > 40) {
        breakPoint = lastSpace;
      }

      chunks.push(remaining.slice(0, breakPoint).trimEnd());
      remaining = remaining.slice(breakPoint).trimStart();
    }

    return { msg: chunks };
  }

  // Retry failed/pending refunds on rejected proposals.
  @Cron(CronExpression.EVERY_5_MINUTES)
  async retryPendingRefunds(): Promise<void> {
    if (this.isRetrying) return;
    this.isRetrying = true;

    try {
      const batchSize = 100;
      let page = 0;
      let hasMore = true;

      while (hasMore) {
        const rejectedProposals = await this.proposalRepository.find({
          where: { status: ProposalStatus.REJECTED },
          select: ['id'],
          skip: page * batchSize,
          take: batchSize,
        });

        if (rejectedProposals.length === 0) {
          hasMore = false;
          continue;
        }

        for (const proposal of rejectedProposals) {
          await this.refundProposalCreationFeeIfNeeded(proposal.id, { throwOnFailure: false });
        }

        if (rejectedProposals.length < batchSize) {
          hasMore = false;
          continue;
        }

        page += 1;
      }
    } catch (error: any) {
      this.logger.error(`retryPendingRefunds failed: ${error?.message || error}`, error?.stack);
    } finally {
      this.isRetrying = false;
    }
  }
}
