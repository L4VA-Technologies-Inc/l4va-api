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

  constructor(
    @InjectRepository(Claim)
    private readonly claimRepository: Repository<Claim>,
    @InjectQueue('cancellationProcessing')
    private readonly cancellationQueue: Queue
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async processPendingCancellations(): Promise<void> {
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

    for (const claim of pendingClaims) {
      await this.cancellationQueue.add(
        'process-cancellation',
        { claimId: claim.id },
        {
          delay: 1000 + Math.random() * 1000, // Random delay to avoid congestion
          attempts: 2,
          backoff: {
            type: 'exponential',
            delay: 5000,
            jitter: 0.3,
          },
          removeOnComplete: 5,
          removeOnFail: 5,
        }
      );
    }
  }
}
