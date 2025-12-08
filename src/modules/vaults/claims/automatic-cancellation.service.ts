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
  private readonly DEFAULT_BATCH_SIZE = 25;

  constructor(
    @InjectRepository(Claim)
    private readonly claimRepository: Repository<Claim>,
    @InjectQueue('cancellationProcessing')
    private readonly cancellationQueue: Queue
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async processPendingCancellations(): Promise<void> {
    const lockKey = 'cancellation-processing-lock';

    const redisClient = await this.cancellationQueue.client;

    const lock = await redisClient.set(lockKey, '1', 'EX', 600, 'NX');

    if (!lock) {
      this.logger.log('Another instance is processing cancellations, skipping...');
      return;
    }

    try {
      const pendingClaims = await this.claimRepository.find({
        select: ['id', 'vault'],
        where: {
          type: ClaimType.CANCELLATION,
          status: ClaimStatus.AVAILABLE,
        },
        relations: ['vault'],
        take: 50,
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

      for (const [vaultId, vaultClaims] of Object.entries(claimsByVault)) {
        this.logger.log(`Processing ${vaultClaims.length} claims for vault ${vaultId}`);

        // Process claims for this vault with dynamic batch sizing
        let processedCount = 0;

        while (processedCount < vaultClaims.length) {
          const remainingClaims = vaultClaims.slice(processedCount);
          const batchSize = Math.min(this.DEFAULT_BATCH_SIZE, remainingClaims.length);
          const batch = remainingClaims.slice(0, batchSize);
          const claimIds = batch.map(claim => claim.id);

          this.logger.log(
            `Queuing batch of ${claimIds.length} claims for vault ${vaultId} ` +
              `(${processedCount + 1}-${processedCount + claimIds.length} of ${vaultClaims.length})`
          );

          await this.cancellationQueue.add(
            'process-batch-cancellation',
            {
              claimIds,
              vaultId, // Pass vault ID for better logging
              attemptedBatchSize: claimIds.length,
            },
            {
              delay: jobIndex * 15000,
              attempts: 3, // Increased attempts to handle size reduction
              backoff: {
                type: 'exponential',
                delay: 15000,
                jitter: 0.3,
              },
              removeOnComplete: 4,
              removeOnFail: 4,
            }
          );

          processedCount += claimIds.length;
          jobIndex++;
        }
      }

      if (jobIndex > 0) {
        this.logger.log(`Queued ${jobIndex} batch jobs for processing`);
      }
    } catch (error) {
      this.logger.error('Error processing pending cancellations:', error);
    } finally {
      await redisClient.del(lockKey);
    }
  }
}
