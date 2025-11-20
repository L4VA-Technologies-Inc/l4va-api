import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';

import { ClaimsService } from './claims.service';

import { AssetsService } from '@/modules/vaults/assets/assets.service';
import { ClaimStatus } from '@/types/claim.types';

interface BatchCancellationJobData {
  claimIds: string[];
  vaultId?: string;
  attemptedBatchSize?: number;
  originalBatchSize?: number;
}

// Define job options as constants
const BATCH_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 15000,
  },
  removeOnComplete: 4,
  removeOnFail: 4,
} as const;

@Processor('cancellationProcessing')
export class CancellationProcessor extends WorkerHost {
  private readonly logger = new Logger(CancellationProcessor.name);
  private readonly MIN_BATCH_SIZE = 5;

  constructor(
    private readonly claimsService: ClaimsService,
    private readonly assetsService: AssetsService,
    @InjectQueue('cancellationProcessing')
    private readonly cancellationQueue: Queue
  ) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    switch (job.name) {
      case 'process-batch-cancellation': {
        return await this.processBatchCancellationClaims(job as Job<BatchCancellationJobData>);
      }
      default: {
        this.logger.warn(`Unknown job name: ${job.name}`);
        throw new Error(`Unknown job name: ${job.name}`);
      }
    }
  }

  private async processBatchCancellationClaims(job: Job<BatchCancellationJobData>): Promise<{
    success: boolean;
    claimIds: string[];
    txHash: string;
    processedAt: string;
    actualBatchSize?: number;
    reducedFrom?: number;
    reason?: string;
  }> {
    const { claimIds, vaultId, originalBatchSize } = job.data;
    const currentBatchSize = claimIds.length;

    this.logger.log(
      `Processing batch cancellation: ${currentBatchSize} claims ` +
        `(vault: ${vaultId || 'unknown'}, attempt: ${job.attemptsMade + 1}/${job.opts.attempts || 3})`
    );

    try {
      const result = await this.claimsService.buildAndSubmitBatchCancellationTransaction(claimIds);

      if (!result.success) {
        throw new Error('Failed to build batch cancellation transaction');
      }

      await job.updateProgress(90);

      // Update all claims status
      await Promise.all(claimIds.map(claimId => this.claimsService.updateClaimStatus(claimId, ClaimStatus.CLAIMED)));

      // Release assets for all claims
      await Promise.all(claimIds.map(claimId => this.assetsService.releaseAssetByClaimId(claimId)));

      await job.updateProgress(100);

      this.logger.log(
        `✅ Successfully processed batch of ${currentBatchSize} claims, tx: ${result.txHash}` +
          (originalBatchSize && originalBatchSize > currentBatchSize ? ` (reduced from ${originalBatchSize})` : '')
      );

      return {
        success: true,
        claimIds,
        txHash: result.txHash,
        processedAt: new Date().toISOString(),
        actualBatchSize: currentBatchSize,
        reducedFrom: originalBatchSize,
      };
    } catch (error) {
      const isSizeError =
        error.message?.toLowerCase().includes('size') ||
        error.message?.toLowerCase().includes('too large') ||
        error.message?.toLowerCase().includes('exceed');

      // If transaction is too large and we haven't reached minimum batch size yet
      if (isSizeError && currentBatchSize > this.MIN_BATCH_SIZE) {
        const newBatchSize = Math.max(this.MIN_BATCH_SIZE, Math.floor(currentBatchSize * 0.67)); // Reduce by ~33%

        this.logger.warn(
          `Transaction size exceeded for ${currentBatchSize} claims. ` +
            `Reducing batch size to ${newBatchSize} and re-queuing...`
        );

        try {
          await this.handleBatchSplit(job, claimIds, vaultId, currentBatchSize, newBatchSize, originalBatchSize);

          // Return special status to indicate split (not a failure)
          return {
            success: false,
            claimIds: [],
            txHash: '',
            processedAt: new Date().toISOString(),
            actualBatchSize: 0,
            reducedFrom: currentBatchSize,
            reason: 'BATCH_SPLIT',
          };
        } catch (splitError) {
          this.logger.error(`Failed to split batch: ${splitError.message}`);
          // Fall through to regular error handling
        }
      }

      // If we're at minimum batch size or it's a different error, mark as failed
      if (job.attemptsMade >= (job.opts.attempts || 3) - 1) {
        this.logger.error(
          `❌ Failed to process batch of ${currentBatchSize} claims after ${job.attemptsMade + 1} attempts: ${error.message}`
        );

        await this.claimsService.updateClaimStatus(claimIds, ClaimStatus.FAILED, {
          failureReason: error.message,
          batchSize: currentBatchSize,
        });
      }

      throw error;
    }
  }

  /**
   * Handle splitting an oversized batch into smaller batches
   */
  private async handleBatchSplit(
    job: Job<BatchCancellationJobData>,
    claimIds: string[],
    vaultId: string,
    currentBatchSize: number,
    newBatchSize: number,
    originalBatchSize?: number
  ): Promise<void> {
    const reducedClaimIds = claimIds.slice(0, newBatchSize);
    const remainingClaimIds = claimIds.slice(newBatchSize);

    // Requeue reduced batch with higher priority (shorter delay)
    try {
      await this.cancellationQueue.add(
        'process-batch-cancellation',
        {
          claimIds: reducedClaimIds,
          vaultId,
          attemptedBatchSize: newBatchSize,
          originalBatchSize: originalBatchSize || currentBatchSize,
        },
        {
          ...BATCH_JOB_OPTIONS,
          delay: 5000,
          priority: 10,
        }
      );

      this.logger.log(`✅ Re-queued ${reducedClaimIds.length} claims with reduced batch size`);
    } catch (queueError) {
      this.logger.error(`Failed to requeue reduced batch: ${queueError.message}`);
      await this.claimsService.updateClaimStatus(reducedClaimIds, ClaimStatus.FAILED, {
        failureReason: `Requeue failed: ${queueError.message}`,
        batchSize: newBatchSize,
      });
      throw queueError;
    }

    // Queue remaining claims if any
    if (remainingClaimIds.length > 0) {
      this.logger.log(`Queuing remaining ${remainingClaimIds.length} claims from oversized batch`);

      try {
        await this.cancellationQueue.add(
          'process-batch-cancellation',
          {
            claimIds: remainingClaimIds,
            vaultId,
            attemptedBatchSize: Math.min(newBatchSize, remainingClaimIds.length),
            originalBatchSize: originalBatchSize || currentBatchSize,
          },
          {
            ...BATCH_JOB_OPTIONS,
            delay: 10000,
            priority: 5,
          }
        );

        this.logger.log(`✅ Queued remaining ${remainingClaimIds.length} claims`);
      } catch (queueError) {
        this.logger.error(`Failed to queue remaining claims: ${queueError.message}`);

        await this.claimsService.updateClaimStatus(remainingClaimIds, ClaimStatus.FAILED, {
          failureReason: `Requeue failed: ${queueError.message}`,
          batchSize: remainingClaimIds.length,
        });
        throw queueError;
      }
    }
  }
}
