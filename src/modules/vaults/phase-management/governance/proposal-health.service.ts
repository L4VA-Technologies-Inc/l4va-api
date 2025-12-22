import { Injectable, Logger, Inject } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';

import type { GovernanceExecutionService } from './governance-execution.service';
import { ProposalSchedulerService } from './proposal-scheduler.service';

import { Proposal } from '@/database/proposal.entity';
import { ProposalStatus } from '@/types/proposal.types';

/**
 * Service responsible for health monitoring and fallback processing of proposals
 * Runs periodic cron jobs to ensure no proposals are missed due to server downtime or scheduling failures
 */
@Injectable()
export class ProposalHealthService {
  private readonly logger = new Logger(ProposalHealthService.name);

  constructor(
    @InjectRepository(Proposal)
    private readonly proposalRepository: Repository<Proposal>,
    private readonly eventEmitter: EventEmitter2,
    private readonly schedulerService: ProposalSchedulerService,
    @Inject('GovernanceExecutionService')
    private readonly executionService: GovernanceExecutionService
  ) {}

  /**
   * Fallback cron job to catch any missed proposals (runs every 6 hours)
   * This ensures that even if the dynamic scheduling fails, proposals will eventually be processed
   */
  @Cron(CronExpression.EVERY_6_HOURS)
  async fallbackProcessProposals(): Promise<void> {
    try {
      // Handle overdue activations using scheduler service
      await this.schedulerService.processOverdueActivations(
        proposalId => this.executionService.activateProposal(proposalId),
        (proposalId, endDate) =>
          this.schedulerService.scheduleExecution(proposalId, endDate, () =>
            this.executionService.processProposal(proposalId)
          )
      );

      // Handle overdue executions
      const expiredProposals = await this.proposalRepository.find({
        where: {
          status: ProposalStatus.ACTIVE,
          endDate: LessThan(new Date()),
        },
        select: ['id'],
      });

      if (expiredProposals.length > 0) {
        this.logger.warn(
          `Fallback: Found ${expiredProposals.length} expired proposals that weren't processed by dynamic scheduling`
        );

        for (const proposal of expiredProposals) {
          await this.executionService.processProposal(proposal.id);
        }
      }
    } catch (error) {
      this.logger.error(`Fallback cron error: ${error.message}`, error.stack);
    }
  }

  /**
   * Monitor the health of proposal scheduling jobs (runs every 30 minutes)
   * Compares the number of proposals in the database with active cron jobs
   * and reschedules if there's a mismatch
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async monitorJobHealth(): Promise<void> {
    try {
      const upcomingProposals = await this.proposalRepository.count({
        where: { status: ProposalStatus.UPCOMING },
      });

      const activeProposals = await this.proposalRepository.count({
        where: { status: ProposalStatus.ACTIVE },
      });

      const jobHealth = this.schedulerService.getJobHealth();
      const activationJobs = jobHealth.activationJobs;
      const executionJobs = jobHealth.executionJobs;

      if (upcomingProposals > activationJobs || activeProposals > executionJobs) {
        this.logger.warn(
          `Job health warning: ${upcomingProposals} upcoming proposals but only ${activationJobs} activation jobs. ` +
            `${activeProposals} active proposals but only ${executionJobs} execution jobs. Rescheduling...`
        );
        await this.schedulerService.restoreSchedules(
          async (proposalId, endDate) => {
            await this.executionService.activateProposal(proposalId);
            this.schedulerService.scheduleExecution(proposalId, endDate, () =>
              this.executionService.processProposal(proposalId)
            );
          },
          proposalId => this.executionService.processProposal(proposalId)
        );
      }

      // Emit health metrics
      this.eventEmitter.emit('governance.health', {
        upcomingProposals,
        activeProposals,
        activationJobs,
        executionJobs,
        timestamp: new Date(),
      });
    } catch (error) {
      this.logger.error(`Error monitoring job health: ${error.message}`, error.stack);
    }
  }
}
