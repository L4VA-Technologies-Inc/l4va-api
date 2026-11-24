import { Injectable, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { CronJob } from 'cron';
import { Repository, LessThanOrEqual } from 'typeorm';

import { Proposal } from '@/database/proposal.entity';
import { ProposalStatus } from '@/types/proposal.types';

@Injectable()
export class ProposalSchedulerService {
  private readonly logger = new Logger(ProposalSchedulerService.name);

  constructor(
    @InjectRepository(Proposal)
    private readonly proposalRepository: Repository<Proposal>,
    private readonly schedulerRegistry: SchedulerRegistry
  ) {}

  /**
   * Schedule proposal activation at the start date
   * @param proposalId - The proposal ID to activate
   * @param startDate - When the proposal should become active
   * @param endDate - When the proposal should end (for scheduling execution)
   * @param onActivate - Callback function to execute on activation
   * @param onScheduleExecution - Callback to schedule execution after activation
   */
  scheduleActivation(
    proposalId: string,
    startDate: Date,
    endDate: Date,
    onActivate: () => Promise<void>,
    onScheduleExecution: () => void
  ): void {
    const jobName = `proposal-activation-${proposalId}`;
    const start = this.toDate(startDate);
    const timeUntilStart = start.getTime() - Date.now();

    this.scheduleOnce(jobName, start, async () => {
      try {
        await onActivate();
        onScheduleExecution();
      } catch (error) {
        this.logger.error(`Error activating proposal ${proposalId}: ${error.message}`, error.stack);
        this.scheduleRetry(`proposal-activation-retry-${proposalId}`, 60000, async () => {
          await onActivate();
          onScheduleExecution();
        });
      }
    });

    if (timeUntilStart > 0) {
      this.logger.log(`Scheduled activation for proposal ${proposalId} at ${new Date(startDate).toISOString()}`);
    } else {
      this.logger.warn(`Proposal ${proposalId} should already be active, activating immediately`);
    }
  }

  /**
   * Schedule proposal execution (vote counting and action execution)
   * @param proposalId - The proposal ID to execute
   * @param endDate - When the proposal voting ends
   * @param onExecute - Callback function to execute when proposal ends
   */
  scheduleExecution(proposalId: string, endDate: Date, onExecute: () => Promise<void>): void {
    const jobName = `proposal-execution-${proposalId}`;
    const fireAt = new Date(this.toDate(endDate).getTime() + 60000);

    this.scheduleOnce(jobName, fireAt, async () => {
      try {
        await onExecute();
      } catch (error) {
        this.logger.error(`Error processing proposal ${proposalId}: ${error.message}`, error.stack);
        this.scheduleRetry(`proposal-retry-${proposalId}`, 180000, onExecute);
      }
    });

    if (fireAt.getTime() > Date.now()) {
      this.logger.log(`Scheduled execution for proposal ${proposalId} at ${fireAt.toISOString()}`);
    } else {
      this.logger.warn(`Proposal ${proposalId} has already ended, processing immediately`);
    }
  }

  /**
   * Schedule a one-shot reminder for snapshot holders who have not voted yet.
   * If the remind time is already in the reminder window, run immediately.
   */
  scheduleVoteReminder(proposalId: string, remindAt: Date, endDate: Date, onRemind: () => Promise<void>): void {
    const jobName = `proposal-vote-reminder-${proposalId}`;
    if (this.toDate(endDate).getTime() <= Date.now()) {
      return;
    }

    this.scheduleOnce(jobName, remindAt, async () => {
      try {
        await onRemind();
      } catch (error) {
        this.logger.error(`Error sending vote reminder for proposal ${proposalId}: ${error.message}`, error.stack);
      }
    });
    this.logger.log(`Scheduled vote reminder for proposal ${proposalId} at ${new Date(remindAt).toISOString()}`);
  }

  /**
   * Restore schedules for existing upcoming and active proposals
   * Called on service initialization
   * @param onActivate - Callback for activation
   * @param onExecute - Callback for execution
   */
  async restoreSchedules(
    onActivate: (proposalId: string, endDate: Date) => Promise<void>,
    onExecute: (proposalId: string) => Promise<void>
  ): Promise<void> {
    try {
      // Single query to get both upcoming and active proposals
      const proposals = await this.proposalRepository.find({
        where: [{ status: ProposalStatus.UPCOMING }, { status: ProposalStatus.ACTIVE }],
        select: ['id', 'status', 'startDate', 'endDate'],
      });

      let upcomingCount = 0;
      let activeCount = 0;

      for (const proposal of proposals) {
        if (proposal.status === ProposalStatus.UPCOMING) {
          this.scheduleActivation(
            proposal.id,
            new Date(proposal.startDate),
            new Date(proposal.endDate),
            () => onActivate(proposal.id, new Date(proposal.endDate)),
            () => this.scheduleExecution(proposal.id, new Date(proposal.endDate), () => onExecute(proposal.id))
          );
          upcomingCount++;
        } else if (proposal.status === ProposalStatus.ACTIVE) {
          this.scheduleExecution(proposal.id, new Date(proposal.endDate), () => onExecute(proposal.id));
          activeCount++;
        }
      }

      this.logger.log(`Restored ${upcomingCount} upcoming and ${activeCount} active proposal schedules`);
    } catch (error) {
      this.logger.error(`Error restoring proposal schedules: ${error.message}`, error.stack);
    }
  }

  /**
   * Process overdue activations (proposals that should have been activated while server was down)
   * @param onActivate - Callback for activation
   * @param onScheduleExecution - Callback to schedule execution after activation
   */
  async processOverdueActivations(
    onActivate: (proposalId: string) => Promise<void>,
    onScheduleExecution: (proposalId: string, endDate: Date) => void
  ): Promise<void> {
    try {
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
          await onActivate(proposal.id);

          // Schedule execution if not already ended
          if (proposal.endDate > new Date()) {
            onScheduleExecution(proposal.id, proposal.endDate);
          } else {
            this.logger.warn(`Proposal ${proposal.id} has already ended, will be processed by fallback job`);
          }
        }
      }
    } catch (error) {
      this.logger.error(`Error processing overdue activations: ${error.message}`, error.stack);
    }
  }

  /**
   * Clean up a scheduled job
   * @param jobName - The name of the job to clean up
   */
  cleanupJob(jobName: string): void {
    try {
      this.schedulerRegistry.deleteCronJob(jobName);
      this.logger.debug(`Cleaned up job: ${jobName}`);
    } catch {
      // Job doesn't exist, which is fine
    }
  }

  /**
   * Clean up all proposal-related jobs
   * Called on module destroy
   */
  cleanupAllJobs(): void {
    const jobs = this.schedulerRegistry.getCronJobs();
    jobs.forEach((value, key) => {
      if (key.startsWith('proposal-')) {
        try {
          this.schedulerRegistry.deleteCronJob(key);
          this.logger.debug(`Cleaned up job: ${key}`);
        } catch (error) {
          this.logger.warn(`Failed to clean up job ${key}: ${error.message}`);
        }
      }
    });
  }

  /**
   * Get job health statistics
   * @returns Object with job counts by type
   */
  getJobHealth(): {
    activationJobs: number;
    executionJobs: number;
    retryJobs: number;
  } {
    const jobs = this.schedulerRegistry.getCronJobs();
    const activationJobs = Array.from(jobs.keys()).filter(key => key.startsWith('proposal-activation-')).length;
    const executionJobs = Array.from(jobs.keys()).filter(key => key.startsWith('proposal-execution-')).length;
    const retryJobs = Array.from(jobs.keys()).filter(key => key.includes('-retry-')).length;

    return {
      activationJobs,
      executionJobs,
      retryJobs,
    };
  }

  /**
   * Schedule a retry job
   * @param jobName - Name for the retry job
   * @param delayMs - Delay in milliseconds before retry
   * @param onRetry - Callback to execute on retry
   */
  private scheduleRetry(jobName: string, delayMs: number, onRetry: () => Promise<void>): void {
    this.scheduleOnce(jobName, new Date(Date.now() + delayMs), async () => {
      try {
        await onRetry();
      } catch (retryError) {
        this.logger.error(`Retry failed for job ${jobName}: ${retryError.message}`);
      }
    });
  }

  private toDate(value: Date | string): Date {
    return value instanceof Date ? value : new Date(value);
  }

  /**
   * One-shot job at an absolute Date. Cron strings are timezone-fragile for this.
   */
  private scheduleOnce(jobName: string, when: Date | string, onFire: () => Promise<void>): void {
    this.cleanupJob(jobName);

    const fireAt = this.toDate(when);
    if (Number.isNaN(fireAt.getTime())) {
      this.logger.error(`Cannot schedule ${jobName}: invalid date ${when}`);
      return;
    }

    const run = async (): Promise<void> => {
      try {
        await onFire();
      } finally {
        this.cleanupJob(jobName);
      }
    };

    if (fireAt.getTime() <= Date.now()) {
      setTimeout(() => {
        void run();
      }, 1000);
      return;
    }

    const job = new CronJob(fireAt, () => {
      void run();
    });
    this.schedulerRegistry.addCronJob(jobName, job);
    job.start();
  }
}
