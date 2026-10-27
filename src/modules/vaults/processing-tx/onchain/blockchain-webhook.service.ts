import { verifyWebhookSignature, SignatureVerificationError } from '@blockfrost/blockfrost-js';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { keccak256 } from 'viem';

import { TransactionsService } from '../offchain-tx/transactions.service';

import { BlockchainWebhookDto, BlockfrostTransaction, BlockfrostTransactionEvent } from './dto/webhook.dto';
import { EvmVaultSignerService } from './evm-vault-signer.service';
import { OnchainTransactionStatus } from './types/transaction-status.enum';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { Transaction } from '@/database/transaction.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { RewardEventProducer } from '@/modules/rewards/services/reward-event-producer.service';
import { AssetsService } from '@/modules/vaults/assets/assets.service';
import { ClaimStatus } from '@/types/claim.types';
import { RewardActivityType } from '@/types/rewards.types';
import { TransactionStatus, TransactionType, EvmReconciliationStatus } from '@/types/transaction.types';
import { ContributionWindowType, InvestmentWindowType, VaultStatus } from '@/types/vault.types';

@Injectable()
export class BlockchainWebhookService {
  private readonly logger = new Logger(BlockchainWebhookService.name);
  private readonly webhookAuthToken: string;
  private readonly maxEventAge: number;
  private readonly vaultCreatedTopic: string;

  // Status mapping for blockchain events
  private readonly STATUS_MAP: Record<OnchainTransactionStatus, TransactionStatus> = {
    [OnchainTransactionStatus.PENDING]: TransactionStatus.pending,
    [OnchainTransactionStatus.CONFIRMED]: TransactionStatus.confirmed,
    [OnchainTransactionStatus.FAILED]: TransactionStatus.failed,
    [OnchainTransactionStatus.NOT_FOUND]: TransactionStatus.stuck,
  };

  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly configService: ConfigService,
    private readonly assetsService: AssetsService,
    private readonly rewardEventProducer: RewardEventProducer,
    private readonly evmVaultSignerService: EvmVaultSignerService,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    @InjectRepository(Claim)
    private readonly claimRepository: Repository<Claim>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>
  ) {
    this.webhookAuthToken = this.configService.get<string>('BLOCKFROST_WEBHOOK_AUTH_TOKEN');
    this.maxEventAge = 600; // 10 minutes max age for webhook events
    this.vaultCreatedTopic = keccak256(
      new TextEncoder().encode('VaultCreated(bytes32,address,address,address,address)')
    ).toLowerCase();
  }

  /**
   * Handle blockchain webhook events from Blockfrost
   * Webhook is configured to trigger on transactions involving vault reference address
   * Filters for vault contributions by checking for receipt token minting
   * Verifies webhook signature using Blockfrost SDK
   */
  async handleBlockchainEvent(rawBody: string, signatureHeader: string): Promise<string[]> {
    // Verify webhook signature using Blockfrost SDK
    let event: BlockchainWebhookDto;
    try {
      const verifiedEvent = verifyWebhookSignature(
        rawBody,
        signatureHeader,
        this.webhookAuthToken,
        this.maxEventAge // Maximum allowed age of the webhook event in seconds
      );
      event = verifiedEvent as unknown as BlockchainWebhookDto;
    } catch (error) {
      if (error instanceof SignatureVerificationError) {
        this.logger.error('Invalid webhook signature', {
          signatureHeader: error.detail?.signatureHeader,
          error: error.message,
        });
        throw new UnauthorizedException('Invalid webhook signature');
      }
      this.logger.error('Error verifying webhook signature', error);
      throw error;
    }

    if (event.type !== 'transaction') {
      this.logger.debug(`Ignoring non-transaction event type: ${event.type}`);
      return [];
    }

    this.logger.debug(`Processing ${event.payload.length} transaction(s) from blockchain webhook`);

    const updatedLocalTxIds: string[] = [];

    for (const txEvent of event.payload) {
      const localTxId = await this.processTransaction(txEvent);
      if (localTxId) {
        updatedLocalTxIds.push(localTxId);
      }
    }

    return updatedLocalTxIds;
  }

  /**
   * Process individual transaction from webhook
   */
  private async processTransaction({ tx }: BlockfrostTransactionEvent): Promise<string> {
    const internalStatus = this.determineInternalTransactionStatus(tx);
    return this.applyTransactionStatus(tx.hash, tx.index, internalStatus);
  }

  /**
   * Update a local transaction status by hash and run the chain-agnostic
   * post-confirmation side effects (locking assets, indexing rewards,
   * claim/cancel handling, createVault transition).
   *
   * Shared between the Cardano (Blockfrost) and EVM (Alchemy) webhooks so that
   * both chains converge on identical downstream logic.
   *
   * @param txHash On-chain transaction hash
   * @param txIndex Transaction index within its block
   * @param internalStatus Resolved internal transaction status
   * @returns Updated local transaction id, or null if no matching transaction
   */
  async applyTransactionStatus(
    txHash: string,
    txIndex: number,
    internalStatus: TransactionStatus
  ): Promise<string | null> {
    try {
      const transaction = await this.transactionsService.updateTransactionStatusByHash(txHash, txIndex, internalStatus);

      if (!transaction) {
        return null;
      }

      if (internalStatus === TransactionStatus.confirmed) {
        if (transaction.type === TransactionType.contribute || transaction.type === TransactionType.acquire) {
          const lockedCount = await this.transactionsService.lockAssetsForTransaction(transaction.id);
          this.logger.log(`Locked ${lockedCount} assets for transaction ${txHash}`);

          // Index reward activity events for confirmed on-chain transactions
          await this.indexRewardEvent(transaction, txHash);
        }

        // NOTE: Token metadata PR submission has been moved to lifecycle.service.ts
        // after decimals are finalized (post-multiplier calculation in governance transition)
        // This ensures the PR contains accurate decimal information

        // Handle createVault confirmation - immediately transition to contribution if uponVaultLaunch
        if (transaction.type === TransactionType.createVault && transaction.vault_id) {
          await this.handleCreateVaultConfirmation(transaction.vault_id);
        }

        // Handle claim transactions - update claim status to CLAIMED
        if (transaction.type === TransactionType.claim && transaction.metadata?.claimIds) {
          const claimIds = transaction.metadata.claimIds as string[];
          try {
            // Update claim status to CLAIMED and set distribution_tx_id
            await this.claimRepository.update(
              { id: In(claimIds) },
              {
                status: ClaimStatus.CLAIMED,
                distribution_tx_id: transaction.id,
                updated_at: new Date(),
              }
            );

            this.logger.log(`WH: Updated status to CLAIMED for ${claimIds.length} claims`);
          } catch (claimError) {
            this.logger.error(
              `WH: Failed to update claims for transaction ${txHash}: ${claimError.message}`,
              claimError.stack
            );
          }
        }

        // Handle extractDispatch transactions - update claims and mark assets as distributed
        if (transaction.type === TransactionType.extractDispatch && transaction.metadata?.claimIds) {
          const claimIds = transaction.metadata.claimIds as string[];
          const transactionIds = transaction.metadata.transactionIds as string[];
          try {
            // Update claim status to CLAIMED and set distribution_tx_id
            // Only update claims that are still PENDING (avoid overwriting already-processed claims)
            const updateResult = await this.claimRepository.update(
              { id: In(claimIds), status: ClaimStatus.PENDING },
              {
                status: ClaimStatus.CLAIMED,
                distribution_tx_id: transaction.id,
                updated_at: new Date(),
              }
            );

            // Mark assets as distributed (idempotent - will only update LOCKED assets)
            if (transactionIds && transactionIds.length > 0) {
              const markedCount = await this.assetsService.markAssetsAsDistributedByTransactions(transactionIds);
              if (markedCount > 0) {
                this.logger.log(`WH: Marked assets as distributed for ${markedCount} transactions`);
              }
            }

            this.logger.log(
              `WH: Processed extractDispatch for ${claimIds.length} acquirer claims ` +
                `(${updateResult.affected || 0} claims updated)`
            );
          } catch (extractError) {
            // Don't throw - this is expected if claims were already processed via UTXO validation
            this.logger.warn(
              `WH: Partial processing for extractDispatch transaction ${txHash}: ${extractError.message}`
            );
          }
        }

        // Handle cancellation transactions - release assets back to contributors
        if (transaction.type === TransactionType.cancel && transaction.metadata?.cancellationClaimIds) {
          const claimIds = transaction.metadata.cancellationClaimIds as string[];
          try {
            // Release assets back to contributors
            await this.assetsService.releaseAssetsByClaim(claimIds);

            // Update claim status to CLAIMED using repository
            await this.claimRepository.update(
              { id: In(claimIds) },
              {
                status: ClaimStatus.CLAIMED,
                updated_at: new Date(),
              }
            );

            this.logger.log(`WH: Released assets and updated status for ${claimIds.length} cancellation claims`);

            // Update user TVL by subtracting returned asset values
            try {
              await this.updateUserTvlForCancellations(claimIds);
            } catch (tvlError) {
              this.logger.error(
                `WH: Failed to update user TVL after cancellation: ${tvlError.message}`,
                tvlError.stack
              );
            }
          } catch (releaseError) {
            this.logger.error(
              `WH: Failed to release assets for cancellation tx ${txHash}: ${releaseError.message}`,
              releaseError.stack
            );
          }
        }
      }

      this.logger.log(`WH: Transaction ${txHash} status updated to ${internalStatus}`);
      return transaction.id;
    } catch (error) {
      this.logger.error(`WH: Failed to process transaction ${txHash}: ${error.message}`, error.stack);
      return null;
    }
  }

  /**
   * Unified EVM confirmation handler shared by both the Alchemy webhook and the
   * health-check cron job. Parses any VaultCreated events from the transaction
   * logs BEFORE applying the status transition so that contract addresses are
   * persisted before handleCreateVaultConfirmation runs.
   *
   * @param txHash  On-chain EVM transaction hash
   * @param txIndex Transaction index within its block
   * @param status  Resolved internal status (confirmed / failed)
   * @param logs    Normalized log entries for this transaction
   */
  async applyEvmTransactionStatus(
    txHash: string,
    txIndex: number,
    status: TransactionStatus,
    logs: { topics: string[]; data: string }[]
  ): Promise<string | null> {
    // Parse VaultCreated events first so vault contract addresses are set
    // before handleCreateVaultConfirmation is called inside applyTransactionStatus
    for (const log of logs) {
      const topics = log.topics ?? [];
      if (topics[0]?.toLowerCase() === this.vaultCreatedTopic) {
        try {
          await this.evmVaultSignerService.updateVaultFromCreatedEvent(txHash, topics, log.data);
        } catch (error) {
          this.logger.error(
            `WH: Failed to update vault from VaultCreated event in tx ${txHash}: ${(error as Error).message}`
          );
        }
      }
    }

    return this.applyTransactionStatus(txHash, txIndex, status);
  }

  /**
   * Idempotently mark an EVM transaction fully reconciled (domain events
   * applied). Only flips from NULL → success — never overwrites 'success'
   * or 'failed'. Used by the Alchemy webhook fast path; the health-check
   * cron is the durable retry path.
   */
  async markEvmTransactionReconciled(txHash: string): Promise<void> {
    await this.transactionRepository
      .createQueryBuilder()
      .update(Transaction)
      .set({
        reconciliation_status: EvmReconciliationStatus.success,
        reconciled_at: () => 'CURRENT_TIMESTAMP',
      })
      .where(
        'tx_hash = :hash AND reconciled_at IS NULL AND (reconciliation_status IS NULL OR reconciliation_status = :pending)',
        {
          hash: txHash,
          pending: EvmReconciliationStatus.pending,
        }
      )
      .execute();
  }

  /**
   * Find the Transaction row that owns an EVM tx hash. Two paths:
   *   1. `transactions.tx_hash = hash` — the classic case.
   *   2. Any Transaction whose `metadata.evmChildTxHashes` array contains
   *      `hash` — for the multi-child contribution flow.
   */
  async findEvmTransactionByHashOrChildHash(hash: string): Promise<Transaction | null> {
    const direct = await this.transactionRepository.findOne({ where: { tx_hash: hash } });
    if (direct) return direct;
    return this.transactionRepository
      .createQueryBuilder('t')
      .where(`t.metadata -> 'evmChildTxHashes' @> :hashArray::jsonb`, {
        hashArray: JSON.stringify([hash]),
      })
      .getOne();
  }

  /**
   * Index a reward activity event when a contribution or acquisition is confirmed on-chain.
   */
  private async indexRewardEvent(transaction: any, txHash: string): Promise<void> {
    try {
      // Look up the user's wallet address
      const user = await this.userRepository.findOne({
        where: { id: transaction.user_id },
        select: ['id', 'address'],
      });
      if (!user?.address) return;

      // Look up the vault to determine expansion vs normal
      const vault = await this.vaultRepository.findOne({
        where: { id: transaction.vault_id },
        select: ['id', 'vault_status'],
      });
      if (!vault) return;

      const isExpansion = vault.vault_status === VaultStatus.expansion;

      if (transaction.type === TransactionType.contribute) {
        // Fetch assets for this transaction to count them
        const assets = await this.assetRepository.find({
          where: { transaction: { id: transaction.id } },
          select: ['id', 'type'],
        });

        // Count by asset: each NFT = 1, each FT = 1
        const units = assets.length;

        // Store asset breakdown for debugging
        const nftCount = assets.filter(a => a.type === 'nft').length;
        const ftCount = assets.filter(a => a.type === 'ft').length;

        await this.rewardEventProducer.indexEvent({
          walletAddress: user.address,
          vaultId: transaction.vault_id,
          eventType: isExpansion
            ? RewardActivityType.EXPANSION_ASSET_CONTRIBUTION
            : RewardActivityType.ASSET_CONTRIBUTION,
          txHash,
          units,
          metadata: {
            transaction_id: transaction.id,
            nft_count: nftCount,
            ft_count: ftCount,
          },
        });
      } else if (transaction.type === TransactionType.acquire) {
        // Acquire: use ADA amount as units (in lovelace)
        const units = transaction.amount || 1;

        await this.rewardEventProducer.indexEvent({
          walletAddress: user.address,
          vaultId: transaction.vault_id,
          eventType: isExpansion ? RewardActivityType.EXPANSION_TOKEN_PURCHASE : RewardActivityType.TOKEN_ACQUIRE,
          txHash,
          units,
          metadata: {
            transaction_id: transaction.id,
            amount: transaction.amount,
          },
        });
      }
    } catch (error) {
      // Non-blocking: reward indexing failure should not break webhook processing
      this.logger.warn(`Failed to index reward event for tx ${txHash}: ${error.message}`);
    }
  }

  private determineInternalTransactionStatus(tx: BlockfrostTransaction): TransactionStatus {
    if (!tx.block || !tx.block_height) {
      return this.STATUS_MAP[OnchainTransactionStatus.PENDING];
    } else if (tx.valid_contract === false) {
      return this.STATUS_MAP[OnchainTransactionStatus.FAILED];
    } else if (tx.valid_contract === true) {
      return this.STATUS_MAP[OnchainTransactionStatus.CONFIRMED];
    }
    return this.STATUS_MAP[OnchainTransactionStatus.PENDING];
  }

  /**
   * Update user TVL by subtracting the value of returned assets from cancellation claims
   * More efficient than recalculating everything - just deducts returned asset values
   */
  private async updateUserTvlForCancellations(claimIds: string[]): Promise<void> {
    // Get claims with user and transaction relationships
    const claims = await this.claimRepository.find({
      where: { id: In(claimIds) },
      relations: ['user', 'transaction', 'transaction.assets'],
      select: {
        id: true,
        user: { id: true, tvl: true, gains: true },
        transaction: {
          id: true,
          amount: true,
          assets: {
            id: true,
            quantity: true,
            dex_price: true,
            floor_price: true,
            type: true,
            decimals: true,
            added_by: true,
          },
        },
      },
    });

    if (claims.length === 0) return;

    // Calculate value to deduct per user
    const userDeductions = new Map<string, number>();

    for (const claim of claims) {
      const userId = claim.user.id;
      let deductionAda = 0;

      // Handle contribution returns (assets)
      if (claim.transaction?.assets && claim.transaction.assets.length > 0) {
        for (const asset of claim.transaction.assets) {
          deductionAda += asset.valueAda;
        }
      }

      // Handle acquisition returns (ADA)
      if (claim.transaction?.amount) {
        // Amount is in lovelace, convert to ADA
        deductionAda += claim.transaction.amount / 1_000_000;
      }

      if (deductionAda > 0) {
        userDeductions.set(userId, (userDeductions.get(userId) || 0) + deductionAda);
      }
    }

    // Batch update user TVLs
    const updatePromises = Array.from(userDeductions.entries()).map(async ([userId, deduction]) => {
      const user = await this.userRepository.findOne({
        where: { id: userId },
        select: ['id', 'tvl', 'gains'],
      });

      if (user) {
        const currentTvl = Number(user.tvl || 0);
        const currentGains = Number(user.gains || 0);
        const newTvl = Math.max(0, currentTvl - deduction); // Ensure TVL doesn't go negative

        // Also adjust gains proportionally if there were gains
        let newGains = currentGains;
        if (currentTvl > 0 && currentGains !== 0) {
          const gainsRatio = currentGains / currentTvl;
          newGains = newTvl * gainsRatio;
        }

        await this.userRepository.update({ id: userId }, { tvl: newTvl, gains: newGains });
      }
    });

    await Promise.all(updatePromises);
    this.logger.log(`WH: Updated TVL for ${userDeductions.size} users after cancellations`);
  }

  /**
   * Handle createVault transaction confirmation
   * Immediately transitions vault to contribution phase if it has ContributionWindowType.uponVaultLaunch
   * This provides faster response than waiting for the cron job
   */
  private async handleCreateVaultConfirmation(vaultId: string): Promise<void> {
    try {
      const vault: Pick<
        Vault,
        | 'id'
        | 'vault_status'
        | 'contribution_open_window_type'
        | 'acquire_open_window_type'
        | 'is_acquire_only'
        | 'name'
      > = await this.vaultRepository.findOne({
        where: { id: vaultId },
        select: [
          'id',
          'vault_status',
          'contribution_open_window_type',
          'acquire_open_window_type',
          'is_acquire_only',
          'name',
        ],
      });

      if (!vault) {
        this.logger.warn(`WH: Vault ${vaultId} not found for createVault confirmation`);
        return;
      }

      // Only transition if vault is published and has uponVaultLaunch type.
      // Acquire-only vaults skip contribution and move directly into acquire phase.
      if (vault.vault_status === VaultStatus.published) {
        const transitionTimestamp = new Date();

        if (vault.is_acquire_only) {
          if (vault.acquire_open_window_type === InvestmentWindowType.uponAssetWindowClosing) {
            await this.vaultRepository.update(
              { id: vaultId },
              {
                vault_status: VaultStatus.acquire,
                acquire_phase_start: transitionTimestamp,
              }
            );

            this.logger.log(
              `WH: Vault "${vault.name}" (${vaultId}) transitioned to acquire phase on createVault confirmation`
            );
            return;
          }
        } else {
          if (vault.contribution_open_window_type === ContributionWindowType.uponVaultLaunch) {
            await this.vaultRepository.update(
              { id: vaultId },
              {
                vault_status: VaultStatus.contribution,
                contribution_phase_start: transitionTimestamp,
              }
            );

            this.logger.log(
              `WH: Vault "${vault.name}" (${vaultId}) transitioned to contribution phase on createVault confirmation`
            );
          }
        }
      }
    } catch (error) {
      this.logger.error(`WH: Failed to handle createVault confirmation for vault ${vaultId}: ${error.message}`);
      // Don't throw - the cron job will handle it as fallback
    }
  }
}
