import { Buffer } from 'node:buffer';

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { FixedTransaction, PrivateKey, Address } from '@emurgo/cardano-serialization-lib-nodejs';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TransactionsService } from '../../processing-tx/offchain-tx/transactions.service';
import { BlockchainService } from '../../processing-tx/onchain/blockchain.service';
import { getUtxosExtract } from '../../processing-tx/onchain/utils/lib';

import { Proposal } from '@/database/proposal.entity';
import { Transaction } from '@/database/transaction.entity';
import { ProposalStatus } from '@/types/proposal.types';
import { TransactionType } from '@/types/transaction.types';

@Injectable()
export class GovernanceRefundService {
  private readonly logger = new Logger(GovernanceRefundService.name);
  private readonly isMainnet: boolean;
  private readonly adminAddress: string;
  private readonly adminSKey: string;
  private blockfrost: BlockFrostAPI;

  private isRetrying = false;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(Proposal)
    private readonly proposalRepository: Repository<Proposal>,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    private readonly blockchainService: BlockchainService,
    private readonly transactionsService: TransactionsService
  ) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    this.adminAddress = this.configService.get<string>('ADMIN_ADDRESS');
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');

    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });
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
      .andWhere(`tx.metadata->>'kind' = :kind`, { kind: 'governance_creation_fee' })
      .andWhere(`tx.metadata->>'proposalId' = :proposalId`, { proposalId })
      .getOne();

    const feeAmount = paymentTx?.amount ?? 0;
    if (feeAmount <= 0) {
      return { refunded: false };
    }

    // Idempotency: don't refund if a refund transaction exists already.
    const existingRefundTx = await this.transactionRepository
      .createQueryBuilder('tx')
      .where('tx.type = :type', { type: TransactionType.payment })
      .andWhere('tx.vault_id = :vaultId', { vaultId: proposal.vaultId })
      .andWhere(`tx.metadata->>'kind' = :kind`, { kind: 'governance_creation_fee_refund' })
      .andWhere(`tx.metadata->>'refundOfProposalId' = :proposalId`, { proposalId })
      .getOne();

    if (existingRefundTx) {
      return { refunded: false };
    }

    try {
      const refundedAt = new Date().toISOString();
      const refundTxHash = await this.submitAdminRefundTx({
        proposalId,
        toAddress: creatorAddress,
        lovelaceAmount: feeAmount,
      });

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

      await this.transactionsService.updateTransactionHash(refundTx.id, refundTxHash, {
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

      if (throwOnFailure) {
        throw new Error(message);
      }

      return { refunded: false };
    }
  }

  private async submitAdminRefundTx(config: {
    proposalId: string;
    toAddress: string;
    lovelaceAmount: number;
  }): Promise<string> {
    const { proposalId, toAddress, lovelaceAmount } = config;

    // Build an ADA-only refund transaction from the admin wallet.
    const { utxos, totalAdaCollected } = await getUtxosExtract(
      Address.from_bech32(this.adminAddress),
      this.blockfrost,
      {
        minAda: 2_000_000,
        excludeMultiAssets: true,
        validateUtxos: false,
        maxUtxos: 200,
        targetAdaAmount: lovelaceAmount + 2_000_000, // cover tx fees + refund
      }
    );

    if ((totalAdaCollected ?? 0) < lovelaceAmount + 2_000_000) {
      throw new Error(
        `Insufficient ADA in admin wallet for refund. Needed: ${(lovelaceAmount + 2_000_000) / 1_000_000}, available: ${(totalAdaCollected ?? 0) / 1_000_000}`
      );
    }

    const input = {
      changeAddress: this.adminAddress,
      message: `Refund governance fee for proposal ${proposalId}`,
      utxos,
      outputs: [
        {
          address: toAddress,
          lovelace: lovelaceAmount,
        },
      ],
      validityInterval: {
        start: true,
        end: true,
      },
      network: this.isMainnet ? ('mainnet' as const) : ('preprod' as const),
    };

    const buildResponse = await this.blockchainService.buildTransaction(input);
    const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
    txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

    const result = await this.blockchainService.submitTransaction({
      transaction: txToSubmitOnChain.to_hex(),
    });

    if (!result.txHash) {
      throw new Error('No txHash returned from blockchain submission');
    }

    return result.txHash;
  }

  // Retry failed/pending refunds on rejected proposals.
  @Cron(CronExpression.EVERY_5_MINUTES)
  async retryPendingRefunds(): Promise<void> {
    if (this.isRetrying) return;
    this.isRetrying = true;

    try {
      const rejectedProposals = await this.proposalRepository.find({
        where: { status: ProposalStatus.REJECTED },
        select: ['id'],
      });

      for (const proposal of rejectedProposals) {
        await this.refundProposalCreationFeeIfNeeded(proposal.id, { throwOnFailure: false });
      }
    } catch (error: any) {
      this.logger.error(`retryPendingRefunds failed: ${error?.message || error}`, error?.stack);
    } finally {
      this.isRetrying = false;
    }
  }
}
