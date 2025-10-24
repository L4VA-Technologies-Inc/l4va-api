import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { ClaimsService } from './claims.service';

import { AssetsService } from '@/modules/vaults/processing-tx/assets/assets.service';
import { ClaimStatus } from '@/types/claim.types';

@Processor('cancellationProcessing')
export class CancellationProcessor extends WorkerHost {
  private readonly logger = new Logger(CancellationProcessor.name);

  constructor(
    private readonly claimsService: ClaimsService,
    private readonly assetsService: AssetsService
  ) {
    super();
  }

  async process(job: Job<{ claimId?: string; claimIds?: string[] }, any, string>): Promise<any> {
    switch (job.name) {
      case 'process-cancellation': {
        return await this.processCancellationClaim(job as Job<{ claimId: string }>);
      }
      case 'process-batch-cancellation': {
        return await this.processBatchCancellationClaims(job as Job<{ claimIds: string[] }>);
      }
      default: {
        this.logger.warn(`Unknown job name: ${job.name}`);
        throw new Error(`Unknown job name: ${job.name}`);
      }
    }
  }

  private async processBatchCancellationClaims(job: Job<{ claimIds: string[] }>): Promise<{
    success: boolean;
    claimIds: string[];
    txHash: string;
    processedAt: string;
  }> {
    const { claimIds } = job.data;

    try {
      const result = await this.claimsService.buildAndSubmitBatchCancellationTransaction(claimIds);

      if (!result.success) {
        throw new Error('Failed to build batch cancellation transaction');
      }

      await job.updateProgress(90);

      if (result.success) {
        // Update all claims status
        await Promise.all(claimIds.map(claimId => this.claimsService.updateClaimStatus(claimId, ClaimStatus.CLAIMED)));

        // Release assets for all claims
        await Promise.all(claimIds.map(claimId => this.assetsService.releaseAssetByClaimId(claimId)));

        await job.updateProgress(100);

        return {
          success: true,
          claimIds,
          txHash: result.txHash,
          processedAt: new Date().toISOString(),
        };
      } else {
        throw new Error('Failed to submit batch cancellation transaction');
      }
    } catch (error) {
      // Mark all claims as failed after multiple attempts
      if (job.attemptsMade >= job.opts.attempts) {
        await Promise.all(
          claimIds.map(claimId =>
            this.claimsService.updateClaimStatus(claimId, ClaimStatus.FAILED, {
              failureReason: error.message,
              lastAttempt: new Date().toISOString(),
              totalAttempts: job.attemptsMade,
            })
          )
        );
        this.logger.error(`Marked claims ${claimIds.join(', ')} as failed after ${job.attemptsMade} attempts`);
      }

      throw error;
    }
  }

  private async processCancellationClaim(job: Job<{ claimId: string }>): Promise<{
    success: boolean;
    claimId: string;
    txHash: string;
    processedAt: string;
  }> {
    const { claimId } = job.data;

    try {
      const result = await this.claimsService.buildAndSubmitCancellationTransaction(claimId);

      if (!result.success) {
        throw new Error('Failed to build cancellation transaction');
      }

      await job.updateProgress(90);

      if (result.success) {
        this.logger.log(
          `Successfully processed automatic cancellation for claim ${claimId}, ` + `tx hash: ${result.txHash}`
        );

        // Update job progress to complete
        await this.claimsService.updateClaimStatus(claimId, ClaimStatus.CLAIMED);
        await this.assetsService.releaseAssetByClaimId(claimId);

        await job.updateProgress(100);

        return {
          success: true,
          claimId,
          txHash: result.txHash,
          processedAt: new Date().toISOString(),
        };
      } else {
        throw new Error('Failed to submit cancellation transaction');
      }
    } catch (error) {
      // Mark claim as failed after multiple attempts
      if (job.attemptsMade >= job.opts.attempts) {
        await this.claimsService.updateClaimStatus(claimId, ClaimStatus.FAILED, {
          failureReason: error.message,
          lastAttempt: new Date().toISOString(),
          totalAttempts: job.attemptsMade,
        });
        this.logger.error(`Marked claim ${claimId} as failed after ${job.attemptsMade} attempts`);
      }

      throw error;
    }
  }
}
