import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';

import { Vault } from '@/database/vault.entity';
import { VaultStatus } from '@/types/vault.types';

@Processor('phaseTransition')
@Injectable()
export class LifecycleProcessor extends WorkerHost {
  private readonly logger = new Logger(LifecycleProcessor.name);

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>
  ) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    this.logger.log(`Processing phase transition job: ${job.name}`, job.data);

    switch (job.name) {
      case 'transitionPhase':
        return await this.updateVaultStatus(job.data);
      default:
        this.logger.warn(`Unknown job name: ${job.name}`);
    }
  }

  // Not used for governance transition
  async updateVaultStatus(data: { vaultId: string; newStatus: VaultStatus; phaseStartField?: string }): Promise<void> {
    try {
      const vault = await this.vaultRepository.findOne({
        where: { id: data.vaultId },
      });

      if (!vault) {
        this.logger.error(`Vault ${data.vaultId} not found`);
        return;
      }

      // Set phase start time if specified
      if (data.phaseStartField) {
        (vault as any)[data.phaseStartField] = new Date().toISOString();
      }

      await this.vaultRepository.save(vault);

      this.logger.log(
        `Successfully updated vault ${data.vaultId} status to ${data.newStatus}` +
          (data.phaseStartField ? ` and set ${data.phaseStartField}` : '')
      );
    } catch (error) {
      this.logger.error(`Failed to update vault ${data.vaultId} status:`, error);
      throw error;
    }
  }
}
