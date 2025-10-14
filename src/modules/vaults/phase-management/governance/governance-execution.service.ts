import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression, SchedulerRegistry } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { CronJob } from 'cron';
import { Repository, LessThan, LessThanOrEqual } from 'typeorm';

import { Proposal } from '@/database/proposal.entity';
import { ProposalStatus } from '@/types/proposal.types';
import { VoteType } from '@/types/vote.types';

@Injectable()
export class GovernanceExecutionService {
  private readonly logger = new Logger(GovernanceExecutionService.name);

  constructor(
    @InjectRepository(Proposal)
    private readonly proposalRepository: Repository<Proposal>,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly eventEmitter: EventEmitter2
  ) {}

  async onModuleInit(): Promise<void> {
    // Process any proposals that should have been activated while server was down
    await this.processUpcomingProposalsOnStartup();

    // Schedule existing upcoming and active proposals on startup
    await this.scheduleExistingProposals();
  }

  @OnEvent('proposal.created')
  async handleProposalCreated(payload: {
    proposalId: string;
    startDate: Date;
    endDate: Date;
    status: ProposalStatus;
  }): Promise<void> {
    if (payload.status === ProposalStatus.UPCOMING) {
      this.scheduleProposalActivation(payload.proposalId, payload.startDate, payload.endDate);
    } else if (payload.status === ProposalStatus.ACTIVE) {
      this.scheduleProposalExecution(payload.proposalId, payload.endDate);
    }
  }

  @OnEvent('proposal.activated')
  async handleProposalActivated(payload: { proposalId: string; endDate: Date }): Promise<void> {
    this.scheduleProposalExecution(payload.proposalId, payload.endDate);
  }

  private scheduleProposalActivation(proposalId: string, startDate: Date, endDate: Date): void {
    const jobName = `proposal-activation-${proposalId}`;

    // Remove existing job if it exists
    try {
      this.schedulerRegistry.deleteCronJob(jobName);
      this.logger.debug(`Removed existing activation job: ${jobName}`);
    } catch (error) {
      // Job doesn't exist, which is fine
    }

    const now = new Date();
    const timeUntilStart = startDate.getTime() - now.getTime();

    // Only schedule if the proposal hasn't started yet
    if (timeUntilStart > 0) {
      const cronPattern = this.createCronPattern(startDate);

      const job = new CronJob(cronPattern, async () => {
        try {
          await this.activateProposal(proposalId);

          // After activation, schedule the execution
          this.scheduleProposalExecution(proposalId, endDate);

          // Clean up the activation job
          try {
            this.schedulerRegistry.deleteCronJob(jobName);
            this.logger.debug(`Cleaned up activation job: ${jobName}`);
          } catch (error) {
            this.logger.warn(`Failed to clean up activation job ${jobName}: ${error.message}`);
          }
        } catch (error) {
          this.logger.error(`Error activating proposal ${proposalId}: ${error.message}`, error.stack);

          // Retry activation after 1 minute
          const retryJobName = `proposal-activation-retry-${proposalId}`;
          const retryTime = new Date(Date.now() + 60000);
          const retryPattern = this.createCronPattern(retryTime);

          const retryJob = new CronJob(retryPattern, async () => {
            try {
              await this.activateProposal(proposalId);
              this.scheduleProposalExecution(proposalId, endDate);
              this.schedulerRegistry.deleteCronJob(retryJobName);
            } catch (retryError) {
              this.logger.error(`Activation retry failed for proposal ${proposalId}: ${retryError.message}`);
              this.schedulerRegistry.deleteCronJob(retryJobName);
            }
          });

          this.schedulerRegistry.addCronJob(retryJobName, retryJob);
          retryJob.start();
        }
      });

      this.schedulerRegistry.addCronJob(jobName, job);
      job.start();

      this.logger.log(`Scheduled activation for proposal ${proposalId} at ${startDate.toISOString()}`);
    } else {
      this.logger.warn(`Proposal ${proposalId} should already be active, activating immediately`);
      // Activate immediately if start date has passed
      setTimeout(async () => {
        await this.activateProposal(proposalId);
        this.scheduleProposalExecution(proposalId, endDate);
      }, 1000);
    }
  }

  private scheduleProposalExecution(proposalId: string, endDate: Date): void {
    const jobName = `proposal-execution-${proposalId}`;

    // Remove existing job if it exists
    try {
      this.schedulerRegistry.deleteCronJob(jobName);
      this.logger.debug(`Removed existing job: ${jobName}`);
    } catch (error) {
      // Job doesn't exist, which is fine
    }

    const now = new Date();
    const timeUntilEnd = endDate.getTime() - now.getTime();

    // Only schedule if the proposal hasn't ended yet
    if (timeUntilEnd > 0) {
      // Create a cron job that runs 1 minute after the proposal ends
      const executionTime = new Date(endDate.getTime() + 60000); // Add 1 minute buffer

      const cronPattern = this.createCronPattern(executionTime);

      const job = new CronJob(cronPattern, async () => {
        try {
          await this.processProposal(proposalId);

          // Clean up the job after execution
          try {
            this.schedulerRegistry.deleteCronJob(jobName);
            this.logger.debug(`Cleaned up job: ${jobName}`);
          } catch (error) {
            this.logger.warn(`Failed to clean up job ${jobName}: ${error.message}`);
          }
        } catch (error) {
          this.logger.error(`Error processing proposal ${proposalId}: ${error.message}`, error.stack);

          // Retry after 2 minutes on error
          const retryJobName = `proposal-retry-${proposalId}`;
          const retryTime = new Date(Date.now() + 120000); // 2 minutes from now
          const retryPattern = this.createCronPattern(retryTime);

          const retryJob = new CronJob(retryPattern, async () => {
            try {
              await this.processProposal(proposalId);
              this.schedulerRegistry.deleteCronJob(retryJobName);
            } catch (retryError) {
              this.logger.error(`Retry failed for proposal ${proposalId}: ${retryError.message}`);
              this.schedulerRegistry.deleteCronJob(retryJobName);
            }
          });

          this.schedulerRegistry.addCronJob(retryJobName, retryJob);
          retryJob.start();
        }
      });

      this.schedulerRegistry.addCronJob(jobName, job);
      job.start();

      this.logger.log(`Scheduled execution for proposal ${proposalId} at ${executionTime.toISOString()}`);
    } else {
      this.logger.warn(`Proposal ${proposalId} has already ended, processing immediately`);
      // Process immediately if already ended
      setTimeout(() => this.processProposal(proposalId), 1000);
    }
  }

  private async activateProposal(proposalId: string): Promise<void> {
    try {
      const proposal = await this.proposalRepository.findOne({
        where: { id: proposalId, status: ProposalStatus.UPCOMING },
        select: ['id', 'status', 'startDate'],
      });

      if (!proposal) {
        this.logger.warn(`Proposal ${proposalId} is not upcoming or doesn't exist`);
        return;
      }

      // Double-check the start time
      if (new Date() >= new Date(proposal.startDate)) {
        await this.proposalRepository.update({ id: proposalId }, { status: ProposalStatus.ACTIVE });

        // Emit event for real-time UI updates
        this.eventEmitter.emit('proposal.status.changed', {
          proposalId: proposal.id,
          status: ProposalStatus.ACTIVE,
          previousStatus: ProposalStatus.UPCOMING,
          timestamp: new Date(),
        });

        this.logger.log(`Proposal ${proposalId} activated successfully`);
      }
    } catch (error) {
      this.logger.error(`Error activating proposal ${proposalId}: ${error.message}`, error.stack);
      throw error;
    }
  }

  private createCronPattern(date: Date): string {
    // Convert Date to cron pattern (second minute hour day month dayOfWeek)
    return `${date.getSeconds()} ${date.getMinutes()} ${date.getHours()} ${date.getDate()} ${date.getMonth() + 1} *`;
  }

  private async scheduleExistingProposals(): Promise<void> {
    try {
      const activeProposals = await this.proposalRepository.find({
        where: { status: ProposalStatus.ACTIVE },
        select: ['id', 'endDate'],
      });

      for (const proposal of activeProposals) {
        this.scheduleProposalExecution(proposal.id, proposal.endDate);
      }

      this.logger.log(`Scheduled ${activeProposals.length} existing active proposals`);
    } catch (error) {
      this.logger.error(`Error scheduling existing proposals: ${error.message}`, error.stack);
    }
  }

  private async processProposal(proposalId: string): Promise<void> {
    try {
      const proposal = await this.proposalRepository.findOne({
        where: { id: proposalId, status: ProposalStatus.ACTIVE },
        relations: {
          vault: true,
          votes: true,
        },
        select: {
          id: true,
          vaultId: true,
          status: true,
          vault: {
            id: true,
            execution_threshold: true,
          },
          votes: {
            voteWeight: true,
            vote: true,
          },
        },
      });

      if (!proposal || !proposal.vault || !proposal.votes) {
        this.logger.warn(`Proposal ${proposalId} is not active or doesn't exist`);
        return;
      }

      const executionThreshold = proposal.vault.execution_threshold;

      let yesVotes = BigInt(0);
      let noVotes = BigInt(0);

      proposal.votes.forEach(vote => {
        const weight = BigInt(vote.voteWeight);
        if (vote.vote === VoteType.YES) yesVotes += weight;
        if (vote.vote === VoteType.NO) noVotes += weight;
      });

      const totalVotes = yesVotes + noVotes;
      const yesVotePercent = totalVotes > 0 ? (Number(yesVotes) / Number(totalVotes)) * 100 : 0;
      const isSuccessful = yesVotePercent >= executionThreshold;
      const newStatus = isSuccessful ? ProposalStatus.EXECUTED : ProposalStatus.REJECTED;

      await this.proposalRepository.update(
        { id: proposal.id },
        {
          status: newStatus,
          executionDate: newStatus === ProposalStatus.EXECUTED ? new Date() : undefined,
        }
      );

      // Emit event for real-time UI updates
      this.eventEmitter.emit('proposal.executed', {
        proposalId: proposal.id,
        vaultId: proposal.vaultId,
        status: newStatus,
        yesVotePercent,
        executionThreshold,
        executionDate: new Date(),
      });

      this.logger.log(
        `Proposal ${proposal.id}: ${newStatus} (${yesVotePercent.toFixed(2)}% yes votes, threshold ${executionThreshold}%)`
      );
    } catch (error) {
      this.logger.error(`Error processing proposal ${proposalId}: ${error.message}`, error.stack);
      throw error;
    }
  }

  private async processUpcomingProposalsOnStartup(): Promise<void> {
    try {
      // Find proposals that should have been activated while server was down
      const overdueProposals = await this.proposalRepository.find({
        where: {
          status: ProposalStatus.UPCOMING,
          startDate: LessThanOrEqual(new Date()),
        },
        select: ['id', 'startDate', 'endDate'],
      });

      if (overdueProposals.length > 0) {
        this.logger.warn(`Activating ${overdueProposals.length} proposals that were overdue during downtime`);

        for (const proposal of overdueProposals) {
          await this.activateProposal(proposal.id);

          // Schedule execution if not already ended
          if (proposal.endDate > new Date()) {
            this.scheduleProposalExecution(proposal.id, proposal.endDate);
          } else {
            // Process immediately if already ended
            await this.processProposal(proposal.id);
          }
        }
      }
    } catch (error) {
      this.logger.error(`Error processing overdue proposals on startup: ${error.message}`, error.stack);
    }
  }

  // Fallback cron job to catch any missed proposals (runs less frequently)
  @Cron(CronExpression.EVERY_6_HOURS)
  async fallbackProcessProposals(): Promise<void> {
    try {
      // Handle overdue activations
      const overdueActivations = await this.proposalRepository.find({
        where: {
          status: ProposalStatus.UPCOMING,
          startDate: LessThanOrEqual(new Date()),
        },
        select: ['id', 'startDate', 'endDate'],
      });

      if (overdueActivations.length > 0) {
        this.logger.warn(`Fallback: Found ${overdueActivations.length} proposals that should have been activated`);

        for (const proposal of overdueActivations) {
          await this.activateProposal(proposal.id);

          // Schedule execution if not already ended
          if (proposal.endDate > new Date()) {
            this.scheduleProposalExecution(proposal.id, proposal.endDate);
          } else {
            await this.processProposal(proposal.id);
          }
        }
      }

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
          await this.processProposal(proposal.id);
        }
      }
    } catch (error) {
      this.logger.error(`Fallback cron error: ${error.message}`, error.stack);
    }
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async monitorJobHealth(): Promise<void> {
    try {
      const upcomingProposals = await this.proposalRepository.count({
        where: { status: ProposalStatus.UPCOMING },
      });

      const activeProposals = await this.proposalRepository.count({
        where: { status: ProposalStatus.ACTIVE },
      });

      const jobs = this.schedulerRegistry.getCronJobs();
      const activationJobs = Array.from(jobs.keys()).filter(key => key.startsWith('proposal-activation-')).length;
      const executionJobs = Array.from(jobs.keys()).filter(key => key.startsWith('proposal-execution-')).length;

      if (upcomingProposals > activationJobs) {
        this.logger.warn(
          `Job health warning: ${upcomingProposals} upcoming proposals but only ${activationJobs} activation jobs`
        );
        await this.scheduleExistingProposals();
      }

      if (activeProposals > executionJobs) {
        this.logger.warn(
          `Job health warning: ${activeProposals} active proposals but only ${executionJobs} execution jobs`
        );
        await this.scheduleExistingProposals();
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

  onModuleDestroy(): void {
    // Clean up all proposal-related cron jobs
    const jobs = this.schedulerRegistry.getCronJobs();
    jobs.forEach((value, key) => {
      if (key.startsWith('proposal-')) {
        try {
          this.schedulerRegistry.deleteCronJob(key);
          this.logger.log(`Cleaned up job: ${key}`);
        } catch (error) {
          this.logger.warn(`Failed to clean up job ${key}: ${error.message}`);
        }
      }
    });
  }
}
