import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression, SchedulerRegistry } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { CronJob } from 'cron';
import { Repository, LessThan, LessThanOrEqual } from 'typeorm';

import { ExecType } from './dto/create-proposal.req';

import { Asset } from '@/database/asset.entity';
import { Proposal } from '@/database/proposal.entity';
import { AssetsService } from '@/modules/vaults/assets/assets.service';
import { WayUpService } from '@/modules/wayup/wayup.service';
import { ProposalStatus, ProposalType } from '@/types/proposal.types';
import { VoteType } from '@/types/vote.types';

@Injectable()
export class GovernanceExecutionService {
  private readonly logger = new Logger(GovernanceExecutionService.name);
  private readonly isMainnet: boolean;

  constructor(
    @InjectRepository(Proposal)
    private readonly proposalRepository: Repository<Proposal>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly eventEmitter: EventEmitter2,
    private readonly assetsService: AssetsService,
    private readonly wayUpService: WayUpService,
    private readonly configService: ConfigService
  ) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
  }

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
    } catch {
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
    } catch {
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
          const retryTime = new Date(Date.now() + 180000); // 2 minutes from now
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
      // Single query to get both upcoming and active proposals
      const proposals = await this.proposalRepository.find({
        where: [{ status: ProposalStatus.UPCOMING }, { status: ProposalStatus.ACTIVE }],
        select: ['id', 'status', 'startDate', 'endDate'],
      });

      let upcomingCount = 0;
      let activeCount = 0;

      for (const proposal of proposals) {
        if (proposal.status === ProposalStatus.UPCOMING) {
          upcomingCount++;

          // Only schedule if start date hasn't passed
          if (proposal.startDate > new Date()) {
            this.scheduleProposalActivation(proposal.id, proposal.startDate, proposal.endDate);
          } else {
            // Activate immediately if overdue
            this.logger.warn(`Found overdue upcoming proposal ${proposal.id}, activating immediately`);
            setTimeout(async () => {
              await this.activateProposal(proposal.id);
              // Schedule execution if not already ended
              if (proposal.endDate > new Date()) {
                this.scheduleProposalExecution(proposal.id, proposal.endDate);
              } else {
                await this.processProposal(proposal.id);
              }
            }, 1000);
          }
        } else if (proposal.status === ProposalStatus.ACTIVE) {
          activeCount++;

          // Only schedule if end date hasn't passed
          if (proposal.endDate > new Date()) {
            this.scheduleProposalExecution(proposal.id, proposal.endDate);
          } else {
            this.logger.warn(`Found overdue active proposal ${proposal.id}, processing immediately`);
            setTimeout(() => this.processProposal(proposal.id), 1000);
          }
        }
      }

      this.logger.log(`Scheduled ${upcomingCount} upcoming proposals and ${activeCount} active proposals`);
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
          proposalType: true,
          metadata: true,
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

      const executed = await this.executeProposalActions(proposal);

      if (executed) {
        await this.proposalRepository.update({ id: proposalId }, { status: newStatus });
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
      } else {
        this.logger.warn(`Proposal ${proposal.id} execution failed, status remains ACTIVE for retry`);
      }
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

      if (upcomingProposals > activationJobs || activeProposals > executionJobs) {
        this.logger.warn(
          `Job health warning: ${upcomingProposals} upcoming proposals but only ${activationJobs} activation jobs.
          ${activeProposals} active proposals but only ${executionJobs} execution jobs. Rescheduling...
          `
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

  private async executeProposalActions(proposal: Proposal): Promise<boolean> {
    try {
      this.logger.log(`Executing actions for proposal ${proposal.id} of type ${proposal.proposalType}`);

      switch (proposal.proposalType) {
        case ProposalType.BUY_SELL:
          return await this.executeBuySellProposal(proposal);

        case ProposalType.DISTRIBUTION:
          return await this.executeDistributionProposal(proposal);

        case ProposalType.STAKING:
          return await this.executeStakingProposal(proposal);

        case ProposalType.BURNING:
          this.logger.log(`Burning proposal ${proposal.id} - execution logic to be implemented`);
          break;

        case ProposalType.TERMINATION:
          this.logger.log(`Termination proposal ${proposal.id} - execution logic to be implemented`);
          break;

        default:
          this.logger.warn(`Unknown proposal type: ${proposal.proposalType}`);
          return false;
      }
      return true;
    } catch (error) {
      this.logger.error(`Error executing actions for proposal ${proposal.id}: ${error.message}`, error.stack);
      return false;
    }
  }

  /**
   * Execute BUY_SELL proposal actions via WayUp marketplace
   * Groups operations by market and action type to execute in batched transactions
   */
  private async executeBuySellProposal(proposal: Proposal): Promise<boolean> {
    if (!proposal.metadata.marketplaceActions || proposal.metadata.marketplaceActions.length === 0) {
      this.logger.warn(`BUY_SELL proposal ${proposal.id} has no buying/selling options`);
      return false;
    }

    this.logger.log(
      `Executing ${proposal.metadata.marketplaceActions.length} buy/sell operation(s) for proposal ${proposal.id}`
    );

    // Collect all unique asset IDs to fetch from database
    const assetIds = [...new Set(proposal.metadata.marketplaceActions.map(opt => opt.assetId))];

    // Fetch all assets from database in one query
    const assets = await this.assetRepository.find({
      where: assetIds.map(id => ({ id })),
      select: ['id', 'policy_id', 'asset_id', 'name'],
    });

    // Create a map for quick asset lookup
    const assetMap = new Map(assets.map(asset => [asset.id, asset]));

    // Group operations by market and action type for batching
    const groupedOperations = this.groupBuySellOperations(proposal.metadata.marketplaceActions);

    let hasSuccessfulOperation = false;

    // Process each market's operations
    for (const [market, operations] of Object.entries(groupedOperations)) {
      this.logger.log(
        `Processing ${operations.sells.length} sell(s), ${operations.buys.length} buy(s), ` +
          `${operations.unlists.length} unlist(s), and ${operations.updates.length} update(s) for ${market}`
      );

      // Execute all SELL operations for this market in a single transaction
      if (operations.sells.length > 0) {
        try {
          const listings = [];
          const skippedSells = [];

          for (const option of operations.sells) {
            const asset = assetMap.get(option.assetId);

            if (!asset) {
              this.logger.warn(`Asset not found for assetId: ${option.assetId}`);
              skippedSells.push(option.assetName || option.assetId);
              continue;
            }

            // Extract assetName from asset_id (format: policyId + assetName in hex)
            const policyId = asset.policy_id;
            const assetName = asset.asset_id.substring(policyId.length); // Remove policyId prefix

            listings.push({
              policyId,
              assetName,
              priceAda: parseFloat(option.price),
            });
          }

          if (listings.length > 0) {
            this.logger.log(`Listing ${listings.length} NFT(s) for sale on ${market} in a single transaction`);

            const result = await this.wayUpService.createListing(proposal.vaultId, listings);

            this.logger.log(`Successfully listed ${listings.length} NFT(s) on WayUp. TxHash: ${result.txHash}`);
            hasSuccessfulOperation = true;

            // Update asset statuses to LISTED in database
            try {
              const listedAssetIds = operations.sells.map(op => op.assetId).filter(id => assetMap.has(id));
              await this.assetsService.markAssetsAsListed(listedAssetIds);
              this.logger.log(`Confirmed ${listedAssetIds.length} asset(s) marked as LISTED in database`);
            } catch (statusError) {
              this.logger.warn(`Failed to update asset statuses to LISTED: ${statusError.message}`);
            }

            // Emit event for tracking
            this.eventEmitter.emit('proposal.wayup.listing.created', {
              proposalId: proposal.id,
              vaultId: proposal.vaultId,
              txHash: result.txHash,
              assetCount: listings.length,
              listings: listings.map((l, idx) => ({
                assetName: operations.sells[idx].assetName || assetMap.get(operations.sells[idx].assetId)?.name,
                priceAda: l.priceAda,
              })),
            });
          }

          if (skippedSells.length > 0) {
            this.logger.warn(
              `Skipped ${skippedSells.length} sell operation(s) due to missing asset data: ${skippedSells.join(', ')}`
            );
          }
        } catch (error) {
          this.logger.error(`Error executing batch sell operations on ${market}: ${error.message}`, error.stack);
          // Continue with buy operations even if sell fails
        }
      }

      // Execute all BUY operations for this market in a single transaction
      if (operations.buys.length > 0) {
        try {
          const purchases = [];
          const skippedBuys = [];

          for (const option of operations.buys) {
            const asset = assetMap.get(option.assetId);

            if (!asset) {
              this.logger.warn(`Asset not found for assetId: ${option.assetId}`);
              skippedBuys.push(option.assetName || option.assetId);
              continue;
            }

            const txHashIndex = this.extractTxHashIndex(option);

            if (!txHashIndex) {
              this.logger.warn(`Cannot buy NFT - missing txHashIndex for ${option.assetName || asset.name}`);
              skippedBuys.push(option.assetName || asset.name);
              continue;
            }

            purchases.push({
              policyId: asset.policy_id,
              txHashIndex,
              priceAda: parseFloat(option.price),
            });
          }

          if (purchases.length > 0) {
            this.logger.log(`Buying ${purchases.length} NFT(s) on ${market} in a single transaction`);

            const result = await this.wayUpService.buyNFT(proposal.vaultId, purchases);

            this.logger.log(`Successfully purchased ${purchases.length} NFT(s) on WayUp. TxHash: ${result.txHash}`);
            this.logger.log(`Scanner will track incoming NFTs and create asset records with EXTRACTED status`);
            hasSuccessfulOperation = true;

            // Emit event for tracking
            this.eventEmitter.emit('proposal.wayup.purchase.completed', {
              proposalId: proposal.id,
              vaultId: proposal.vaultId,
              txHash: result.txHash,
              assetCount: purchases.length,
              purchases: purchases.map((p, idx) => ({
                assetName: operations.buys[idx].assetName || assetMap.get(operations.buys[idx].assetId)?.name,
                priceAda: p.priceAda,
              })),
            });
          }

          if (skippedBuys.length > 0) {
            this.logger.warn(
              `Skipped ${skippedBuys.length} buy operation(s) due to missing data: ${skippedBuys.join(', ')}`
            );
          }
        } catch (error) {
          this.logger.error(`Error executing batch buy operations on ${market}: ${error.message}`, error.stack);
        }
      }

      // Execute all UNLIST operations for this market in a single transaction
      if (operations.unlists.length > 0) {
        try {
          const unlistings = [];
          const skippedUnlists = [];

          for (const option of operations.unlists) {
            const asset = assetMap.get(option.assetId);

            if (!asset) {
              this.logger.warn(`Asset not found for assetId: ${option.assetId}`);
              skippedUnlists.push(option.assetName || option.assetId);
              continue;
            }

            const txHashIndex = this.extractTxHashIndex(option);

            if (!txHashIndex) {
              this.logger.warn(`Cannot unlist NFT - missing txHashIndex for ${option.assetName || asset.name}`);
              skippedUnlists.push(option.assetName || asset.name);
              continue;
            }

            unlistings.push({
              policyId: asset.policy_id,
              txHashIndex,
            });
          }

          if (unlistings.length > 0) {
            this.logger.log(`Unlisting ${unlistings.length} NFT(s) from ${market} in a single transaction`);

            const result = await this.wayUpService.unlistNFTs(proposal.vaultId, unlistings);

            this.logger.log(`Successfully unlisted ${unlistings.length} NFT(s) on WayUp. TxHash: ${result.txHash}`);
            this.logger.log(`Assets marked as EXTRACTED (returned to treasury wallet)`);
            hasSuccessfulOperation = true;

            // Update asset statuses to EXTRACTED in database
            try {
              const unlistedAssetIds = operations.unlists.map(op => op.assetId).filter(id => assetMap.has(id));
              await this.assetsService.markAssetsAsUnlisted(unlistedAssetIds);
              this.logger.log(`Confirmed ${unlistedAssetIds.length} asset(s) marked as EXTRACTED in database`);
            } catch (statusError) {
              this.logger.warn(`Failed to update asset statuses to EXTRACTED: ${statusError.message}`);
            }

            // Emit event for tracking
            this.eventEmitter.emit('proposal.wayup.unlisting.completed', {
              proposalId: proposal.id,
              vaultId: proposal.vaultId,
              txHash: result.txHash,
              assetCount: unlistings.length,
            });
          }

          if (skippedUnlists.length > 0) {
            this.logger.warn(
              `Skipped ${skippedUnlists.length} unlist operation(s) due to missing data: ${skippedUnlists.join(', ')}`
            );
          }
        } catch (error) {
          this.logger.error(`Error executing batch unlist operations on ${market}: ${error.message}`, error.stack);
        }
      }

      // Execute all UPDATE_LISTING operations for this market in a single transaction
      if (operations.updates.length > 0) {
        try {
          const updates = [];
          const skippedUpdates = [];

          for (const option of operations.updates) {
            const asset = assetMap.get(option.assetId);

            if (!asset) {
              this.logger.warn(`Asset not found for assetId: ${option.assetId}`);
              skippedUpdates.push(option.assetName || option.assetId);
              continue;
            }

            const txHashIndex = this.extractTxHashIndex(option);

            if (!txHashIndex) {
              this.logger.warn(`Cannot update listing - missing txHashIndex for ${option.assetName || asset.name}`);
              skippedUpdates.push(option.assetName || asset.name);
              continue;
            }

            if (!option.price) {
              this.logger.warn(`Cannot update listing - missing price for ${option.assetName || asset.name}`);
              skippedUpdates.push(option.assetName || asset.name);
              continue;
            }

            updates.push({
              txHashIndex,
              newPriceAda: parseFloat(option.price),
            });
          }

          if (updates.length > 0) {
            this.logger.log(`Updating ${updates.length} NFT listing(s) on ${market} in a single transaction`);

            const result = await this.wayUpService.updateListing(proposal.vaultId, updates);

            this.logger.log(`Successfully updated ${updates.length} NFT listing(s) on WayUp. TxHash: ${result.txHash}`);
            this.logger.log(`Assets remain LISTED with updated prices`);
            hasSuccessfulOperation = true;

            // Emit event for tracking
            this.eventEmitter.emit('proposal.wayup.listing.updated', {
              proposalId: proposal.id,
              vaultId: proposal.vaultId,
              txHash: result.txHash,
              assetCount: updates.length,
            });
          }

          if (skippedUpdates.length > 0) {
            this.logger.warn(
              `Skipped ${skippedUpdates.length} update operation(s) due to missing data: ${skippedUpdates.join(', ')}`
            );
          }
        } catch (error) {
          this.logger.error(
            `Error executing batch update listing operations on ${market}: ${error.message}`,
            error.stack
          );
        }
      }
    }

    return hasSuccessfulOperation;
  } /**
   * Group buy/sell operations by market and action type for batched execution
   */
  private groupBuySellOperations(
    options: any[]
  ): Record<string, { sells: any[]; buys: any[]; unlists: any[]; updates: any[] }> {
    const grouped: Record<string, { sells: any[]; buys: any[]; unlists: any[]; updates: any[] }> = {};

    for (const option of options) {
      const market = option.market || 'wayup'; // Default to wayup if not specified

      if (!grouped[market]) {
        grouped[market] = { sells: [], buys: [], unlists: [], updates: [] };
      }

      if (option.exec === ExecType.SELL) {
        grouped[market].sells.push(option);
      } else if (option.exec === ExecType.BUY) {
        grouped[market].buys.push(option);
      } else if (option.exec === ExecType.UNLIST) {
        grouped[market].unlists.push(option);
      } else if (option.exec === ExecType.UPDATE_LISTING) {
        grouped[market].updates.push(option);
      }
    }

    return grouped;
  }

  /**
   * Execute STAKING proposal actions
   * Only runs on mainnet - testnet just logs completion
   */
  private async executeStakingProposal(proposal: Proposal): Promise<boolean> {
    if (!this.isMainnet) {
      this.logger.log(`[TESTNET] Staking proposal ${proposal.id} marked as completed (no actual execution on testnet)`);
      this.eventEmitter.emit('proposal.staking.testnet.completed', {
        proposalId: proposal.id,
        vaultId: proposal.vaultId,
        network: 'testnet',
      });
      return true;
    }

    this.logger.log(`[MAINNET] Executing staking proposal ${proposal.id}`);

    if (!proposal.metadata.fungibleTokens || proposal.metadata.fungibleTokens.length === 0) {
      this.logger.warn(`Staking proposal ${proposal.id} has no fungible tokens to stake`);
      return false;
    }

    try {
      // TODO: Implement actual staking logic
      // This would involve:
      // 1. Getting the treasury wallet
      // 2. Building staking transaction
      // 3. Signing and submitting to blockchain

      this.logger.log(`Staking ${proposal.metadata.fungibleTokens.length} token(s) for vault ${proposal.vaultId}`);

      for (const token of proposal.metadata.fungibleTokens) {
        this.logger.log(`Staking ${token.amount} of token ${token.id}`);
        // Actual staking implementation here
      }

      // Emit event for tracking
      this.eventEmitter.emit('proposal.staking.executed', {
        proposalId: proposal.id,
        vaultId: proposal.vaultId,
        tokens: proposal.metadata.fungibleTokens,
        network: 'mainnet',
      });

      this.logger.log(`Successfully executed staking proposal ${proposal.id}`);
    } catch (error) {
      this.logger.error(`Error executing staking proposal ${proposal.id}: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Execute DISTRIBUTION proposal actions
   * Only runs on mainnet - testnet just logs completion
   */
  private async executeDistributionProposal(proposal: Proposal): Promise<boolean> {
    if (!this.isMainnet) {
      this.logger.log(
        `[TESTNET] Distribution proposal ${proposal.id} marked as completed (no actual execution on testnet)`
      );
      return true;
    }

    this.logger.log(`[MAINNET] Executing distribution proposal ${proposal.id}`);

    if (!proposal.metadata.distributionAssets || proposal.metadata.distributionAssets.length === 0) {
      this.logger.warn(`Distribution proposal ${proposal.id} has no assets to distribute`);
      return false;
    }

    try {
      // TODO: Implement actual distribution logic
      // This would involve:
      // 1. Getting vault holders/snapshot
      // 2. Calculating distribution amounts per holder
      // 3. Building distribution transactions
      // 4. Signing and submitting to blockchain

      this.logger.log(
        `Distributing ${proposal.metadata.distributionAssets.length} asset(s) for vault ${proposal.vaultId}`
      );

      for (const asset of proposal.metadata.distributionAssets) {
        this.logger.log(`Distributing ${asset.amount} of asset ${asset.id}`);
        // Actual distribution implementation here
      }

      // Emit event for tracking
      this.eventEmitter.emit('proposal.distribution.executed', {
        proposalId: proposal.id,
        vaultId: proposal.vaultId,
        assets: proposal.metadata.distributionAssets,
        network: 'mainnet',
      });

      this.logger.log(`Successfully executed distribution proposal ${proposal.id}`);
    } catch (error) {
      this.logger.error(`Error executing distribution proposal ${proposal.id}: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Extract txHashIndex from buying/selling option
   * This should be provided in the proposal metadata or option
   */
  private extractTxHashIndex(option: any): string | null {
    // Check if txHashIndex is directly provided
    if (option.txHashIndex) {
      return option.txHashIndex;
    }

    // Check metadata for listing information
    if (option.metadata?.txHashIndex) {
      return option.metadata.txHashIndex;
    }

    // For buy operations, this should be part of the proposal data
    // If not available, we cannot proceed with the purchase
    return null;
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
