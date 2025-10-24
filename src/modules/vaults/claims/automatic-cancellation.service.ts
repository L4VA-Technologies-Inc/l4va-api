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

  @Cron(CronExpression.EVERY_10_MINUTES)
  async processPendingCancellations(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      const pendingClaims = await this.claimRepository.find({
        select: ['id', 'vault'],
        where: {
          type: ClaimType.CANCELLATION,
          status: ClaimStatus.AVAILABLE,
        },
        relations: ['vault'],
        take: 12,
      });

      if (pendingClaims.length > 0) {
        this.logger.log(`Found ${pendingClaims.length} pending cancellation claims to process`);
      }

      // Group claims by vault
      const claimsByVault = pendingClaims.reduce(
        (groups, claim) => {
          const vaultId = claim.vault.id;
          if (!groups[vaultId]) {
            groups[vaultId] = [];
          }
          groups[vaultId].push(claim);
          return groups;
        },
        {} as Record<string, typeof pendingClaims>
      );

      let jobIndex = 0;
      for (const [_vaultId, vaultClaims] of Object.entries(claimsByVault)) {
        // Process in batches of up to 3 claims per vault
        for (let i = 0; i < vaultClaims.length; i += 3) {
          const batch = vaultClaims.slice(i, i + 3);
          const claimIds = batch.map(claim => claim.id);

          await this.cancellationQueue.add(
            'process-batch-cancellation',
            { claimIds },
            {
              delay: jobIndex * 15000, // Increased delay for batch processing
              attempts: 2,
              backoff: {
                type: 'exponential',
                delay: 15000,
                jitter: 0.3,
              },
              removeOnComplete: 4,
              removeOnFail: 4,
            }
          );

          jobIndex++;
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }
}
