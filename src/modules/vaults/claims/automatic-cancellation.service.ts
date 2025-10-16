import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';

import { Claim } from '@/database/claim.entity';
import { ClaimStatus, ClaimType } from '@/types/claim.types';

@Injectable()
export class AutomaticCancellationService {
  private readonly logger = new Logger(AutomaticCancellationService.name);
  private isProcessing = false;

  constructor(
    @InjectRepository(Claim)
    private readonly claimRepository: Repository<Claim>,
    @InjectQueue('cancellationProcessing')
    private readonly cancellationQueue: Queue
  ) {}

  // @Cron(CronExpression.EVERY_10_MINUTES)
  async processPendingCancellations(): Promise<void> {
    if (this.isProcessing) {
      this.logger.log('Cancellation processing already in progress, skipping...');
      return;
    }

    this.isProcessing = true;

    try {
      const pendingClaims = await this.claimRepository.find({
        select: ['id'],
        where: {
          type: ClaimType.CANCELLATION,
          status: ClaimStatus.AVAILABLE,
        },
        take: 5, // Process in batches
      });

      if (pendingClaims.length > 0) {
        this.logger.log(`Found ${pendingClaims.length} pending cancellation claims to process`);
      }

      for (let i = 0; i < pendingClaims.length; i++) {
        const claim = pendingClaims[i];

        // TODO: This logic breaks the flow
        // const existingJob = await this.cancellationQueue.getJob(`cancellation-${claim.id}`);
        // if (existingJob && !['completed', 'failed'].includes(existingJob.finishedOn ? 'completed' : 'active')) {
        //   this.logger.log(`Job for claim ${claim.id} already exists, skipping...`);
        //   continue;
        // }

        await this.cancellationQueue.add(
          'process-cancellation',
          { claimId: claim.id },
          {
            // jobId: `cancellation-${claim.id}`,
            delay: i * 10000,
            attempts: 2,
            backoff: {
              type: 'exponential',
              delay: 10000,
              jitter: 0.3,
            },
            removeOnComplete: 4,
            removeOnFail: 4,
          }
        );
      }
    } finally {
      this.isProcessing = false;
    }
  }
}
