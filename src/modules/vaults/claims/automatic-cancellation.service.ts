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

    for (let i = 0; i < pendingClaims.length; i++) {
      const claim = pendingClaims[i];
      await this.cancellationQueue.add(
        'process-cancellation',
        { claimId: claim.id },
        {
          delay: i * 10000, // 10-second delay between each transaction (0s, 10s, 20s, 30s...)
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
  }
}
