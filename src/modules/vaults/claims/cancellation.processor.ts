import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { ClaimsService } from './claims.service';

import { AssetsService } from '@/modules/vaults/assets/assets.service';
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

  async process(job: Job<{ claimId: string }, any, string>): Promise<any> {
    switch (job.name) {
      case 'process-cancellation': {
        return await this.processCancellationClaim(job);
      }
      default: {
        this.logger.warn(`Unknown job name: ${job.name}`);
        throw new Error(`Unknown job name: ${job.name}`);
      }
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
      this.logger.log(`Processing cancellation claim ${claimId}...`);
      await job.updateProgress(10);

      // Build and submit transaction with confirmation
      const result = await this.claimsService.buildAndSubmitCancellationTransaction(claimId);
      await job.updateProgress(70);

      if (!result.success) {
        throw new Error('Failed to build and submit cancellation transaction');
      }

      this.logger.log(
        `Cancellation transaction submitted and confirmed for claim ${claimId}, tx hash: ${result.txHash}`
      );
      await job.updateProgress(90);

      // Update claim status and release assets only after confirmation
      await this.claimsService.updateClaimStatus(claimId, ClaimStatus.CLAIMED, {
        processedAt: new Date().toISOString(),
        txHash: result.txHash,
        confirmationStatus: 'confirmed',
      });

      // Release assets associated with this claim
      try {
        await this.assetsService.releaseAssetByClaimId(claimId);
      } catch (assetError) {
        // Log but don't fail the whole process if asset release fails
        this.logger.warn(`Failed to release assets for claim ${claimId}:`, assetError.message);
      }

      await job.updateProgress(100);

      this.logger.log(`Successfully processed cancellation for claim ${claimId}`);

      return {
        success: true,
        claimId,
        txHash: result.txHash,
        processedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error(`Error processing cancellation claim ${claimId}:`, error);

      // Update claim status with failure info if this is the final attempt
      if (job.attemptsMade >= (job.opts.attempts || 1)) {
        await this.claimsService.updateClaimStatus(claimId, ClaimStatus.FAILED, {
          failureReason: error.message,
          lastAttempt: new Date().toISOString(),
          totalAttempts: job.attemptsMade,
          processingFailed: true,
        });

        this.logger.error(`Marked cancellation claim ${claimId} as failed after ${job.attemptsMade} attempts`);
      }

      throw error;
    }
  }
}
