import { verifyWebhookSignature, SignatureVerificationError } from '@blockfrost/blockfrost-js';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { TransactionsService } from '../offchain-tx/transactions.service';

import { BlockchainWebhookDto, BlockfrostTransaction, BlockfrostTransactionEvent } from './dto/webhook.dto';
import { MetadataRegistryApiService } from './metadata-register.service';
import { OnchainTransactionStatus } from './types/transaction-status.enum';

import { Claim } from '@/database/claim.entity';
import { User } from '@/database/user.entity';
import { AssetsService } from '@/modules/vaults/assets/assets.service';
import { AssetType } from '@/types/asset.types';
import { ClaimStatus } from '@/types/claim.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

@Injectable()
export class BlockchainWebhookService {
  private readonly logger = new Logger(BlockchainWebhookService.name);
  private readonly webhookAuthToken: string;
  private readonly maxEventAge: number;

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
    private readonly metadataRegistryApiService: MetadataRegistryApiService,
    private readonly assetsService: AssetsService,
    @InjectRepository(Claim)
    private readonly claimRepository: Repository<Claim>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>
  ) {
    this.webhookAuthToken = this.configService.get<string>('BLOCKFROST_WEBHOOK_AUTH_TOKEN');
    this.maxEventAge = 600; // 10 minutes max age for webhook events
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
    try {
      const internalStatus = this.determineInternalTransactionStatus(tx);
      const transaction = await this.transactionsService.updateTransactionStatusByHash(
        tx.hash,
        tx.index,
        internalStatus
      );

      if (!transaction) {
        return null;
      }

      if (internalStatus === TransactionStatus.confirmed) {
        if (transaction.type === TransactionType.contribute || transaction.type === TransactionType.acquire) {
          const lockedCount = await this.transactionsService.lockAssetsForTransaction(transaction.id);
          this.logger.log(`Locked ${lockedCount} assets for transaction ${tx.hash}`);
        }

        // NOTE: Token metadata PR submission has been moved to lifecycle.service.ts
        // after decimals are finalized (post-multiplier calculation in governance transition)
        // This ensures the PR contains accurate decimal information

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
              `WH: Failed to release assets for cancellation tx ${tx.hash}: ${releaseError.message}`,
              releaseError.stack
            );
          }
        }

        // TODO: For extract dispatch transactions, we should mark assets as distributed
      }

      this.logger.log(`WH: Transaction ${tx.hash} status updated to ${internalStatus}`);
      return transaction.id;
    } catch (error) {
      this.logger.error(`WH: Failed to process transaction ${tx.hash}: ${error.message}`, error.stack);
      return null;
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
          const price = asset.type === AssetType.NFT ? asset.floor_price || 0 : asset.dex_price || 0;
          const value = Number(asset.quantity) * price;
          deductionAda += value;
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
      const user = await this.userRepository.findOne({ where: { id: userId }, select: ['id', 'tvl', 'gains'] });

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
}
