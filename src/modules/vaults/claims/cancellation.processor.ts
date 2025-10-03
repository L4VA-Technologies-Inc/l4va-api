import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';

import { ClaimsService } from './claims.service';

import { Claim } from '@/database/claim.entity';
import { ClaimStatus } from '@/types/claim.types';

@Processor('cancellationProcessing')
export class CancellationProcessor extends WorkerHost {
  private readonly logger = new Logger(CancellationProcessor.name);

  constructor(
    @InjectRepository(Claim)
    private readonly claimRepository: Repository<Claim>,
    private readonly claimsService: ClaimsService
  ) {
    super();
  }

  async process(job: Job<{ claimId: string }, any, string>): Promise<any> {
    switch (job.name) {
      case 'process-cancellation': {
        return this.logger.debug('--- IGNORE ---');
        // return await this.processCancellationClaim(job);
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
    txHash: any;
    processedAt: string;
  }> {
    const { claimId } = job.data;

    try {
      this.logger.log(`Processing automatic cancellation for claim ${claimId}`);

      await job.updateProgress(10);

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
      this.logger.error(`Failed to process cancellation claim ${claimId}:`, error);

      // Mark claim as failed after multiple attempts
      if (job.attemptsMade >= job.opts.attempts) {
        const claim = await this.claimRepository.findOne({ where: { id: claimId } });
        if (claim) {
          claim.status = ClaimStatus.FAILED;
          claim.metadata = {
            ...claim.metadata,
            failureReason: error.message,
            lastAttempt: new Date().toISOString(),
            totalAttempts: job.attemptsMade,
          };
          await this.claimRepository.save(claim);

          this.logger.error(`Marked claim ${claimId} as failed after ${job.attemptsMade} attempts`);
        }
      }

      throw error;
    }
  }
}
