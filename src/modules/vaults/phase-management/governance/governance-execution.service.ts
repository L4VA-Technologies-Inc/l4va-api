import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { DistributionService } from './distribution.service';
import { ExecType, MarketplaceActionDto } from './dto/create-proposal.req';
import { ProposalSchedulerService } from './proposal-scheduler.service';
import { TerminationService } from './termination.service';
import { VoteCountingService } from './vote-counting.service';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { Proposal } from '@/database/proposal.entity';
import { DexHunterPricingService } from '@/modules/dexhunter/dexhunter-pricing.service';
import { DexHunterService } from '@/modules/dexhunter/dexhunter.service';
import { AssetsService } from '@/modules/vaults/assets/assets.service';
import { TransactionsService } from '@/modules/vaults/processing-tx/offchain-tx/transactions.service';
import { TreasuryExtractionService } from '@/modules/vaults/treasure/treasury-extraction.service';
import { WayUpService } from '@/modules/wayup/wayup.service';
import { AssetStatus } from '@/types/asset.types';
import { ClaimType } from '@/types/claim.types';
import { ProposalStatus, ProposalType } from '@/types/proposal.types';
import { TransactionStatus } from '@/types/transaction.types';

@Injectable()
export class GovernanceExecutionService {
  private readonly logger = new Logger(GovernanceExecutionService.name);
  private readonly isMainnet: boolean;
  private readonly blockfrost: BlockFrostAPI;
  private readonly BURN_WALLET_TESTNET =
    'addr_test1qzdv6pn0ltar7q3hhgrgts2yqvphxtptr4m3t4xf5lfyx7hc3v9amrnu0cp6zt3vkry03838n2mv9e69g8e70aqktgcsnvkule';
  private readonly BURN_WALLET_MAINNET =
    'addr1qxnk9w6e3azattu87ythnnjt2vmtlskzcld0ptwa924j0znz7v4zyqfqapmueh24l2r8v848mya68nndvjy783m656kq0cxjsn';

  // Retry configuration constants
  private readonly MAX_EXECUTION_RETRIES = 5;
  private readonly RETRY_BACKOFF_MINUTES = 5; // Base backoff time in minutes

  constructor(
    @InjectRepository(Proposal)
    private readonly proposalRepository: Repository<Proposal>,
    @InjectRepository(Claim)
    private readonly claimRepository: Repository<Claim>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    private readonly eventEmitter: EventEmitter2,
    private readonly assetsService: AssetsService,
    private readonly wayUpService: WayUpService,
    private readonly configService: ConfigService,
    private readonly schedulerService: ProposalSchedulerService,
    private readonly voteCountingService: VoteCountingService,
    private readonly treasuryExtractionService: TreasuryExtractionService,
    private readonly transactionsService: TransactionsService,
    private readonly terminationService: TerminationService,
    private readonly distributionService: DistributionService,
    private readonly dexHunterService: DexHunterService,
    private readonly dexHunterPricingService: DexHunterPricingService
  ) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });
  }

  async onModuleInit(): Promise<void> {
    // Process any proposals that should have been activated while server was down
    await this.schedulerService.processOverdueActivations(
      proposalId => this.activateProposal(proposalId),
      (proposalId, endDate) =>
        this.schedulerService.scheduleExecution(proposalId, endDate, () => this.processProposal(proposalId))
    );

    // Schedule existing upcoming and active proposals on startup
    await this.schedulerService.restoreSchedules(
      async (proposalId, endDate) => {
        await this.activateProposal(proposalId);
        this.schedulerService.scheduleExecution(proposalId, endDate, () => this.processProposal(proposalId));
      },
      proposalId => this.processProposal(proposalId)
    );
  }

  @OnEvent('proposal.created')
  async handleProposalCreated(payload: {
    proposalId: string;
    startDate: Date;
    endDate: Date;
    status: ProposalStatus;
  }): Promise<void> {
    if (payload.status === ProposalStatus.UPCOMING) {
      this.schedulerService.scheduleActivation(
        payload.proposalId,
        payload.startDate,
        payload.endDate,
        () => this.activateProposal(payload.proposalId),
        () =>
          this.schedulerService.scheduleExecution(payload.proposalId, payload.endDate, () =>
            this.processProposal(payload.proposalId)
          )
      );
    } else if (payload.status === ProposalStatus.ACTIVE) {
      this.schedulerService.scheduleExecution(payload.proposalId, payload.endDate, () =>
        this.processProposal(payload.proposalId)
      );
    }
  }

  @OnEvent('proposal.activated')
  async handleProposalActivated(payload: { proposalId: string; endDate: Date }): Promise<void> {
    this.schedulerService.scheduleExecution(payload.proposalId, payload.endDate, () =>
      this.processProposal(payload.proposalId)
    );
  }

  /**
   * Handle termination completion event
   * Marks the termination proposal as EXECUTED after all steps are complete
   */
  @OnEvent('proposal.termination.completed')
  async handleTerminationCompleted(payload: { proposalId: string; vaultId: string }): Promise<void> {
    try {
      const proposal = await this.proposalRepository.findOne({
        where: { id: payload.proposalId },
        select: ['id', 'status', 'metadata'],
      });

      if (!proposal) {
        this.logger.warn(`Proposal ${payload.proposalId} not found for termination completion`);
        return;
      }

      // Clear executionError from metadata on successful execution
      const updatedMetadata = { ...proposal.metadata };
      delete updatedMetadata.executionError;

      // Mark proposal as EXECUTED now that all termination steps are complete
      await this.proposalRepository.update(
        { id: payload.proposalId },
        {
          status: ProposalStatus.EXECUTED,
          executionDate: new Date(),
          metadata: updatedMetadata,
        }
      );

      this.logger.log(
        `Proposal ${payload.proposalId}: EXECUTED successfully (termination complete for vault ${payload.vaultId})`
      );
    } catch (error) {
      this.logger.error(
        `Failed to mark termination proposal ${payload.proposalId} as executed: ${error.message}`,
        error.stack
      );
    }
  }

  /**
   * Retry execution of all PASSED proposals with exponential backoff
   * Runs periodically to retry proposals that are in PASSED status but not yet executed
   * Implements retry limits and exponential backoff to prevent indefinite retries
   * Also handles distribution batch retries for DISTRIBUTION proposals
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async retryPassedProposals(): Promise<void> {
    try {
      // Find all proposals in PASSED status with metadata for retry tracking
      const passedProposals = await this.proposalRepository.find({
        where: { status: ProposalStatus.PASSED },
        select: ['id', 'title', 'vaultId', 'metadata', 'proposalType'],
      });

      if (passedProposals.length === 0) {
        return;
      }

      for (const proposal of passedProposals) {
        try {
          // Special handling for DISTRIBUTION proposals with pending batch retries
          if (proposal.proposalType === ProposalType.DISTRIBUTION && proposal.metadata?.distribution?.batches) {
            const hasPendingRetries = proposal.metadata.distribution.batches.some(
              (b: any) => b.status === 'retry_pending'
            );

            if (hasPendingRetries) {
              this.logger.log(`Retrying pending distribution batches for proposal ${proposal.id}`);
              const result = await this.distributionService.retryFailedBatches(proposal.id);

              if (result.retriedCount > 0) {
                this.logger.log(
                  `Retried ${result.retriedCount} batches for proposal ${proposal.id}: ` +
                    `${result.successCount} succeeded, ${result.stillFailedCount} still failed`
                );

                // Check if all batches are now complete
                const status = await this.distributionService.getDistributionStatus(proposal.id);
                if (status.status === 'completed') {
                  await this.proposalRepository.update(
                    { id: proposal.id },
                    { status: ProposalStatus.EXECUTED, executionDate: new Date() }
                  );
                  this.logger.log(`Distribution proposal ${proposal.id} fully completed, marked as EXECUTED`);
                }
              }
              continue; // Skip normal retry logic for distribution proposals with pending batches
            }
          }

          const retryInfo = proposal.metadata?._executionRetry;
          const retryCount = retryInfo?.count || 0;
          const lastRetryAt = retryInfo?.lastAttempt ? new Date(retryInfo.lastAttempt) : null;

          // Check if max retries exceeded
          if (retryCount >= this.MAX_EXECUTION_RETRIES) {
            continue;
          }

          // Calculate exponential backoff: base * 2^retryCount minutes
          const backoffMinutes = this.RETRY_BACKOFF_MINUTES * Math.pow(2, retryCount);
          const nextRetryTime = lastRetryAt ? new Date(lastRetryAt.getTime() + backoffMinutes * 60 * 1000) : new Date(); // First retry, execute immediately

          // Check if enough time has passed since last retry
          if (lastRetryAt && new Date() < nextRetryTime) {
            this.logger.debug(
              `Proposal ${proposal.id} is in backoff period. Next retry at ${nextRetryTime.toISOString()}`
            );
            continue;
          }

          this.logger.log(
            `Retrying execution for PASSED proposal ${proposal.id} (${proposal.title}) - Attempt ${retryCount + 1}/${this.MAX_EXECUTION_RETRIES}`
          );

          // Update retry tracking in metadata before execution
          const updatedMetadata = {
            ...proposal.metadata,
            _executionRetry: {
              count: retryCount + 1,
              lastAttempt: new Date().toISOString(),
            },
          };

          await this.proposalRepository.update({ id: proposal.id }, { metadata: updatedMetadata });

          await this.executePassedProposal(proposal.id);
        } catch (error) {
          this.logger.error(`Error retrying execution for proposal ${proposal.id}: ${error.message}`, error.stack);
          // Continue with next proposal - retry count already incremented
        }
      }
    } catch (error) {
      this.logger.error(`Error in retryPassedProposals: ${error.message}`, error.stack);
    }
  }

  async activateProposal(proposalId: string): Promise<void> {
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

  async processProposal(proposalId: string): Promise<void> {
    try {
      const proposal = await this.proposalRepository
        .createQueryBuilder('proposal')
        .leftJoinAndSelect('proposal.vault', 'vault')
        .leftJoinAndSelect('vault.owner', 'owner')
        .leftJoinAndSelect('vault.treasury_wallet', 'treasury_wallet')
        .leftJoinAndSelect('proposal.votes', 'votes')
        .leftJoinAndSelect('proposal.snapshot', 'snapshot')
        .where('proposal.id = :proposalId', { proposalId })
        .andWhere('proposal.status = :status', { status: ProposalStatus.ACTIVE })
        .select([
          'proposal.id',
          'proposal.vaultId',
          'proposal.snapshotId',
          'proposal.status',
          'proposal.proposalType',
          'proposal.metadata',
          'proposal.title',
          'proposal.creatorId',
          'vault.id',
          'vault.name',
          'vault.execution_threshold',
          'vault.cosigning_threshold',
          'treasury_wallet.treasury_address',
          'owner.address',
          'votes.voteWeight',
          'votes.vote',
          'snapshot.addressBalances',
        ])
        .getOne();

      if (!proposal || !proposal.vault || !proposal.votes) {
        this.logger.warn(`Proposal ${proposalId} is not active or doesn't exist`);
        return;
      }

      const executionThreshold = proposal.vault.execution_threshold;
      const participationThreshold = proposal.vault.cosigning_threshold || 0;

      // Calculate total voting power from snapshot
      let totalVotingPower = BigInt(0);
      if (proposal.snapshot?.addressBalances) {
        for (const balance of Object.values(proposal.snapshot.addressBalances)) {
          totalVotingPower += BigInt(balance);
        }
      }

      // Use vote counting service to calculate results with both thresholds
      const voteResult = this.voteCountingService.calculateResult(
        proposal.votes,
        executionThreshold,
        participationThreshold,
        totalVotingPower > BigInt(0) ? totalVotingPower : undefined
      );
      const isSuccessful = voteResult.isSuccessful;

      const finalContributorClaims = await this.claimRepository.find({
        where: {
          vault: { id: proposal.vaultId },
          type: ClaimType.CONTRIBUTOR,
        },
        relations: ['transaction', 'transaction.assets'],
        order: { created_at: 'ASC' },
      });

      // If proposal is not successful, move to REJECTED
      if (!isSuccessful) {
        await this.proposalRepository.update({ id: proposalId }, { status: ProposalStatus.REJECTED });

        this.eventEmitter.emit('proposal.rejected', {
          address: proposal.vault?.owner?.address || null,
          vaultId: proposal.vaultId,
          vaultName: proposal.vault?.name || null,
          proposalName: proposal.title,
          creatorId: proposal.creatorId,
          tokenHolderIds: [...new Set(finalContributorClaims.map(c => c.user_id))],
        });

        const rejectionReason = !voteResult.meetsParticipationThreshold
          ? `participation ${voteResult.participationPercent.toFixed(2)}% < required ${participationThreshold}%`
          : `yes votes ${voteResult.yesVotePercent.toFixed(2)}% < threshold ${executionThreshold}%`;

        this.logger.log(`Proposal ${proposal.id}: REJECTED (${rejectionReason})`);
        return;
      }

      // Proposal vote is successful, move to PASSED status (ready for execution)
      // Reset retry counter in metadata when first moving to PASSED status
      const updatedMetadata = {
        ...proposal.metadata,
        _executionRetry: {
          count: 0,
          lastAttempt: null,
        },
      };

      await this.proposalRepository.update(
        { id: proposalId },
        { status: ProposalStatus.PASSED, metadata: updatedMetadata }
      );

      this.logger.log(
        `Proposal ${proposal.id}: PASSED (participation: ${voteResult.participationPercent.toFixed(2)}%, yes votes: ${voteResult.yesVotePercent.toFixed(2)}%, thresholds: ${participationThreshold}%/${executionThreshold}%)`
      );

      // Immediately trigger execution
      await this.executePassedProposal(proposalId);
    } catch (error) {
      this.logger.error(`Error processing proposal ${proposalId}: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Execute a PASSED proposal
   * Retrieves proposals from PASSED status and executes them
   */
  async executePassedProposal(proposalId: string): Promise<void> {
    let proposal: Proposal | null = null;

    try {
      proposal = await this.proposalRepository
        .createQueryBuilder('proposal')
        .leftJoinAndSelect('proposal.vault', 'vault')
        .leftJoinAndSelect('vault.owner', 'owner')
        .leftJoinAndSelect('vault.treasury_wallet', 'treasury_wallet')
        .where('proposal.id = :proposalId', { proposalId })
        .andWhere('proposal.status = :status', { status: ProposalStatus.PASSED })
        .select([
          'proposal.id',
          'proposal.vaultId',
          'proposal.snapshotId',
          'proposal.status',
          'proposal.proposalType',
          'proposal.metadata',
          'proposal.title',
          'proposal.creatorId',
          'vault.id',
          'vault.name',
          'treasury_wallet.treasury_address',
          'owner.address',
        ])
        .getOne();

      if (!proposal) {
        this.logger.warn(`Proposal ${proposalId} is not in PASSED status or doesn't exist`);
        return;
      }

      const finalContributorClaims = await this.claimRepository.find({
        where: {
          vault: { id: proposal.vaultId },
          type: ClaimType.CONTRIBUTOR,
        },
        relations: ['transaction', 'transaction.assets'],
        order: { created_at: 'ASC' },
      });

      // Execute proposal actions
      const executed = await this.executeProposalActions(proposal);

      if (executed) {
        // Clear executionError from metadata on successful execution
        const updatedMetadata = { ...proposal.metadata };
        delete updatedMetadata.executionError;

        await this.proposalRepository.update(
          { id: proposalId },
          {
            status: ProposalStatus.EXECUTED,
            executionDate: new Date(),
            metadata: updatedMetadata,
          }
        );

        this.eventEmitter.emit('proposal.executed', {
          address: proposal.vault?.owner?.address || null,
          vaultId: proposal.vaultId,
          vaultName: proposal.vault?.name || null,
          proposalName: proposal.title,
          creatorId: proposal.creatorId,
          tokenHolderIds: [...new Set(finalContributorClaims.map(c => c.user_id))],
        });

        this.logger.log(`Proposal ${proposal.id}: EXECUTED successfully`);
      } else {
        this.logger.warn(`Proposal ${proposal.id} execution failed, status remains PASSED for automatic retry`);
      }
    } catch (error) {
      // Check if this is a handled rejection (e.g., listing not found - NFT was already bought)
      if (error.message === 'PROPOSAL_REJECTED_LISTING_NOT_FOUND') {
        this.logger.log(`Proposal ${proposalId}: REJECTED - Listing not found, NFT was likely already purchased`);
        return;
      }

      // Check if this is a handled rejection due to no valid operations (all assets already listed/not listed)
      if (error.message === 'PROPOSAL_REJECTED_NO_VALID_OPERATIONS') {
        this.logger.log(
          `Proposal ${proposalId}: REJECTED - No valid marketplace operations (assets already listed or not available)`
        );
        return;
      }

      // Check if this is a handled rejection due to asset already being listed
      if (error.message === 'PROPOSAL_REJECTED_ASSET_ALREADY_LISTED') {
        this.logger.log(`Proposal ${proposalId}: REJECTED - Asset is already listed on marketplace`);
        return;
      }

      // Check if this is a handled rejection due to assets not being in LOCKED status
      if (error.message === 'PROPOSAL_REJECTED_ASSETS_NOT_LOCKED') {
        this.logger.log(`Proposal ${proposalId}: REJECTED - One or more assets are not in LOCKED status`);
        return;
      }

      // Store execution error in proposal metadata
      if (proposal) {
        await this.storeExecutionError(proposal, error);
      }

      this.logger.error(`Error executing proposal ${proposalId}: ${error.message}`, error.stack);
      throw error;
    }
  }

  private async executeProposalActions(proposal: Proposal): Promise<boolean> {
    const finalContributorClaims = await this.claimRepository.find({
      where: {
        vault: { id: proposal.vaultId },
        type: ClaimType.CONTRIBUTOR,
      },
      relations: ['transaction', 'transaction.assets'],
      order: { created_at: 'ASC' },
    });

    try {
      switch (proposal.proposalType) {
        case ProposalType.MARKETPLACE_ACTION:
          return await this.executeMarketplaceProposal(proposal);

        case ProposalType.BUY_SELL:
          return await this.executeMarketplaceProposal(proposal);

        case ProposalType.DISTRIBUTION:
          return await this.executeDistributionProposal(proposal);

        case ProposalType.STAKING:
          return await this.executeStakingProposal(proposal);

        case ProposalType.BURNING:
          return await this.executeBurningProposal(proposal);

        case ProposalType.TERMINATION:
          return await this.executeTerminationProposal(proposal);

        default:
          this.logger.warn(`Unknown proposal type: ${proposal.proposalType}`);
          return false;
      }
    } catch (error) {
      if (
        error.message === 'PROPOSAL_REJECTED_LISTING_NOT_FOUND' ||
        error.message === 'PROPOSAL_REJECTED_NO_VALID_OPERATIONS' ||
        error.message === 'PROPOSAL_REJECTED_ASSET_ALREADY_LISTED' ||
        error.message === 'PROPOSAL_REJECTED_ASSETS_NOT_LOCKED'
      ) {
        throw error;
      }

      // For other errors, store them and emit failure event
      this.eventEmitter.emit('proposal.failed', {
        address: proposal.vault?.owner?.address || null,
        vaultId: proposal.vaultId,
        vaultName: proposal.vault?.name || null,
        proposalName: proposal.title,
        creatorId: proposal.creatorId,
        tokenHolderIds: [...new Set(finalContributorClaims.map(c => c.user_id))],
      });
      this.logger.error(`Error executing actions for proposal ${proposal.id}: ${error.message}`, error.stack);
      return false;
    }
  }

  /**
   * Execute Marketplace proposal actions via WayUp marketplace or DexHunter swap
   * Executes all marketplace operations (list, unlist, update, buy) in a single atomic transaction for WayUp
   * Executes FT token swaps via DexHunter for token swaps
   * Only runs on mainnet - testnet just logs completion
   */
  private async executeMarketplaceProposal(proposal: Proposal): Promise<boolean> {
    if (!proposal.metadata.marketplaceActions || proposal.metadata.marketplaceActions.length === 0) {
      this.logger.warn(`Marketplace proposal ${proposal.id} has no marketplace options`);
      return false;
    }

    // Check which market this proposal uses
    const market = proposal.metadata.marketplaceActions[0]?.market;

    // Handle DexHunter FT swaps
    if (market === 'DexHunter') {
      return this.executeDexHunterSwapProposal(proposal);
    }

    // Handle WayUp NFT marketplace (existing logic)
    if (!this.isMainnet) {
      this.logger.log(
        `[TESTNET] BUY_SELL proposal ${proposal.id} marked as completed (no actual execution on testnet)`
      );
      return true;
    }

    // Collect all unique asset IDs to fetch from database
    const assetIds = [...new Set(proposal.metadata.marketplaceActions.map(opt => opt.assetId))];

    // Fetch all assets from database in one query (including floor_price for Market sellType)
    const assets: Pick<
      Asset,
      'id' | 'policy_id' | 'asset_id' | 'name' | 'metadata' | 'listing_tx_hash' | 'floor_price'
    >[] = await this.assetRepository.find({
      where: assetIds.map(id => ({ id })),
      select: ['id', 'policy_id', 'asset_id', 'name', 'metadata', 'listing_tx_hash', 'floor_price'],
    });

    // Create a map for quick asset lookup
    const assetMap = new Map(assets.map(asset => [asset.id, asset]));
    const groupedOperations = this.groupBuySellOperations(proposal.metadata.marketplaceActions);

    // For now, we only support WayUp marketplace
    const operations = groupedOperations['wayup'];
    if (!operations) {
      this.logger.warn(`No WayUp marketplace operations found for proposal ${proposal.id}`);
      return false;
    }

    try {
      this.logger.log(
        `Processing ${operations.sells.length} sell(s), ${operations.buys.length} buy(s), ` +
          `${operations.unlists.length} unlist(s), and ${operations.updates.length} update(s) for WayUp`
      );

      // Prepare all action inputs
      const listings: { policyId: string; assetName: string; priceAda: number }[] = [];
      const listingAssetInfos: { assetId: string; price: number }[] = [];
      const assetsToExtract: string[] = [];
      const unlistings: { policyId: string; assetName: string; txHashIndex: string }[] = [];
      const unlistedAssetIds: string[] = [];
      const updates: { policyId: string; assetName: string; txHashIndex: string; newPriceAda: number }[] = [];
      const updateAssetInfos: { assetId: string; newPrice: number }[] = [];
      const purchases: { policyId: string; txHashIndex: string; priceAda: number }[] = [];

      const skipped: { sells: string[]; buys: string[]; unlists: string[]; updates: string[] } = {
        sells: [],
        buys: [],
        unlists: [],
        updates: [],
      };

      // Process SELL operations
      for (const option of operations.sells) {
        const asset = assetMap.get(option.assetId);
        if (!asset) {
          this.logger.warn(`Asset not found for assetId: ${option.assetId}`);
          skipped.sells.push(option.assetId);
          continue;
        }

        // Check if asset is already listed (has listing_tx_hash) - reject entire proposal
        if (asset.listing_tx_hash) {
          const reason = `Asset "${asset.name || option.assetId}" is already listed on marketplace`;
          this.logger.warn(`Marketplace proposal ${proposal.id} rejected: ${reason}`);

          // Store execution error before rejecting so users can see the reason
          await this.storeExecutionError(proposal, new Error(reason));

          await this.proposalRepository.update({ id: proposal.id }, { status: ProposalStatus.REJECTED });

          this.eventEmitter.emit('proposal.rejected', {
            address: proposal.vault?.owner?.address || null,
            vaultId: proposal.vaultId,
            vaultName: proposal.vault?.name || null,
            proposalName: proposal.title,
            creatorId: proposal.creatorId,
            tokenHolderIds: [],
            reason,
          });

          throw new Error('PROPOSAL_REJECTED_ASSET_ALREADY_LISTED');
        }

        const policyId = asset.policy_id;
        const assetName = asset.asset_id;

        // Determine price based on sellType
        let priceAda: number;
        if (option.sellType === 'Market' && !option.price) {
          // Use floor price for Market sellType when no custom price provided
          priceAda = asset.floor_price || 5; // Fallback to 5 ADA minimum if no floor price
          this.logger.log(`Using floor price ${priceAda} ADA for Market listing of ${asset.name || option.assetId}`);
        } else {
          // Use provided price for List sellType or Market with custom price
          priceAda = parseFloat(option.price);
          if (isNaN(priceAda) || priceAda <= 0) {
            this.logger.warn(`Invalid price for ${asset.name || option.assetId}, skipping`);
            skipped.sells.push(asset.name || option.assetId);
            continue;
          }
        }

        listings.push({ policyId, assetName, priceAda });
        listingAssetInfos.push({ assetId: option.assetId, price: priceAda });
        assetsToExtract.push(option.assetId);
      }

      // Process UNLIST operations
      for (const option of operations.unlists) {
        const asset = assetMap.get(option.assetId);
        if (!asset) {
          this.logger.warn(`Asset not found for assetId: ${option.assetId}`);
          skipped.unlists.push(option.assetId);
          continue;
        }

        const txHashIndex = asset.listing_tx_hash;
        if (!txHashIndex) {
          this.logger.warn(`Cannot unlist NFT - missing listing_tx_hash for ${asset.name}`);
          skipped.unlists.push(asset.name || option.assetId);
          continue;
        }

        unlistings.push({ policyId: asset.policy_id, assetName: asset.asset_id, txHashIndex });
        unlistedAssetIds.push(option.assetId);
      }

      // Process UPDATE_LISTING operations
      for (const option of operations.updates) {
        const asset = assetMap.get(option.assetId);
        if (!asset) {
          this.logger.warn(`Asset not found for assetId: ${option.assetId}`);
          skipped.updates.push(option.assetId);
          continue;
        }

        const txHashIndex = asset.listing_tx_hash;
        if (!txHashIndex) {
          this.logger.warn(`Cannot update listing - missing listing_tx_hash for ${asset.name}`);
          skipped.updates.push(asset.name || option.assetId);
          continue;
        }

        if (!option.newPrice) {
          this.logger.warn(`Cannot update listing - missing new price for ${asset.name}`);
          skipped.updates.push(asset.name || option.assetId);
          continue;
        }

        const newPriceAda = parseFloat(option.newPrice);
        updates.push({ policyId: asset.policy_id, assetName: asset.asset_id, txHashIndex, newPriceAda });
        updateAssetInfos.push({ assetId: option.assetId, newPrice: newPriceAda });
      }

      // Process BUY operations
      for (const option of operations.buys) {
        const asset = assetMap.get(option.assetId);
        if (!asset) {
          this.logger.warn(`Asset not found for assetId: ${option.assetId}`);
          skipped.buys.push(option.assetId);
          continue;
        }

        const txHashIndex = asset.listing_tx_hash;
        if (!txHashIndex) {
          this.logger.warn(`Cannot buy NFT - missing txHashIndex for ${option.assetId}`);
          skipped.buys.push(option.assetId);
          continue;
        }

        purchases.push({
          policyId: asset.policy_id,
          txHashIndex,
          priceAda: parseFloat(option.price),
        });
      }

      // Log skipped operations
      if (skipped.sells.length > 0) {
        this.logger.warn(`Skipped ${skipped.sells.length} sell(s): ${skipped.sells.join(', ')}`);
      }
      if (skipped.buys.length > 0) {
        this.logger.warn(`Skipped ${skipped.buys.length} buy(s): ${skipped.buys.join(', ')}`);
      }
      if (skipped.unlists.length > 0) {
        this.logger.warn(`Skipped ${skipped.unlists.length} unlist(s): ${skipped.unlists.join(', ')}`);
      }
      if (skipped.updates.length > 0) {
        this.logger.warn(`Skipped ${skipped.updates.length} update(s): ${skipped.updates.join(', ')}`);
      }

      // Check if there are any valid operations
      const hasOperations = listings.length > 0 || unlistings.length > 0 || updates.length > 0 || purchases.length > 0;

      if (!hasOperations) {
        // Determine the reason for no valid operations
        const totalSkipped =
          skipped.sells.length + skipped.buys.length + skipped.unlists.length + skipped.updates.length;
        let reason = 'No valid marketplace operations to execute';

        if (totalSkipped > 0) {
          const reasons: string[] = [];
          if (skipped.sells.length > 0) {
            reasons.push(`${skipped.sells.length} asset(s) already listed`);
          }
          if (skipped.unlists.length > 0) {
            reasons.push(`${skipped.unlists.length} asset(s) not listed`);
          }
          if (skipped.updates.length > 0) {
            reasons.push(`${skipped.updates.length} asset(s) not listed for update`);
          }
          if (skipped.buys.length > 0) {
            reasons.push(`${skipped.buys.length} asset(s) not available for purchase`);
          }
          reason = `All operations skipped: ${reasons.join(', ')}`;
        }

        this.logger.warn(`Marketplace proposal ${proposal.id} rejected: ${reason}`);

        // Store execution error before rejecting so users can see the reason
        await this.storeExecutionError(proposal, new Error(reason));

        await this.proposalRepository.update({ id: proposal.id }, { status: ProposalStatus.REJECTED });

        this.eventEmitter.emit('proposal.rejected', {
          address: proposal.vault?.owner?.address || null,
          vaultId: proposal.vaultId,
          vaultName: proposal.vault?.name || null,
          proposalName: proposal.title,
          creatorId: proposal.creatorId,
          tokenHolderIds: [],
          reason,
        });

        // Throw specific error so processProposal knows the proposal was already handled
        throw new Error('PROPOSAL_REJECTED_NO_VALID_OPERATIONS');
      }

      // STEP 1: Extract assets to treasury if there are listings (only for assets not already in treasury)
      if (listings.length > 0) {
        if (!proposal.vault.treasury_wallet?.treasury_address) {
          throw new Error(`Treasury wallet not configured for vault ${proposal.vaultId}`);
        }
        const treasuryAddress = proposal.vault.treasury_wallet.treasury_address;

        // Check which assets are already in the treasury wallet by directly querying UTXOs
        const assetsInTreasury = new Set<string>();
        try {
          const treasuryUtxos = await this.blockfrost.addressesUtxosAll(treasuryAddress);
          for (const utxo of treasuryUtxos) {
            for (const amount of utxo.amount) {
              if (amount.unit !== 'lovelace') {
                assetsInTreasury.add(amount.unit);
              }
            }
          }
          this.logger.log(`Found ${assetsInTreasury.size} unique asset(s) in treasury wallet`);
        } catch (error) {
          // If treasury wallet has never received transactions, Blockfrost returns 404
          if (error.status_code === 404 || error.message?.includes('not been found')) {
            this.logger.log(`Treasury wallet ${treasuryAddress} is empty (no transactions yet)`);
          } else {
            this.logger.log(`Treasury wallet query failed: ${error.message}`);
          }
        }

        // Filter out assets that are already in treasury
        const assetsNeedingExtraction = assetsToExtract.filter(assetId => {
          const asset = assetMap.get(assetId);
          if (!asset) return false;
          const fullAssetUnit = asset.policy_id + asset.asset_id;
          return !assetsInTreasury.has(fullAssetUnit);
        });

        if (assetsNeedingExtraction.length > 0) {
          this.logger.log(
            `Extracting ${assetsNeedingExtraction.length} asset(s) from vault to treasury wallet before listing ` +
              `(${assetsToExtract.length - assetsNeedingExtraction.length} already in treasury)`
          );

          const extractionResult = await this.treasuryExtractionService.extractAssetsFromVault({
            vaultId: proposal.vaultId,
            assetIds: assetsNeedingExtraction,
            treasuryAddress,
            isBurn: false,
            skipOnchain: false, // Listing is not supported on testnet
          });

          this.logger.log(
            `Successfully submitted extraction for ${extractionResult.extractedAssets.length} asset(s) to treasury. TxId: ${extractionResult.transactionId}`
          );

          const confirmed = await this.transactionsService.waitForTransactionStatus(
            extractionResult.transactionId,
            TransactionStatus.confirmed,
            120000
          );

          if (!confirmed) {
            throw new Error(`Extraction transaction ${extractionResult.txHash} not confirmed within timeout`);
          }

          await new Promise(resolve => setTimeout(resolve, 5000));
        } else {
          this.logger.log(
            `All ${assetsToExtract.length} asset(s) for listing are already in treasury wallet, skipping extraction`
          );
        }
      }

      // STEP 2: Execute all marketplace actions in a single atomic transaction
      this.logger.log(
        `Executing combined marketplace actions: ${listings.length} listings, ${unlistings.length} unlistings, ` +
          `${updates.length} updates, ${purchases.length} purchases`
      );

      const result = await this.wayUpService.executeCombinedMarketplaceActions(proposal.vaultId, {
        listings: listings.length > 0 ? listings : undefined,
        unlistings: unlistings.length > 0 ? unlistings : undefined,
        updates: updates.length > 0 ? updates : undefined,
        purchases: purchases.length > 0 ? purchases : undefined,
      });

      this.logger.log(`Combined marketplace transaction completed. TxHash: ${result.txHash}`);
      this.logger.log(`Summary: ${JSON.stringify(result.summary)}`);

      // STEP 3: Update database records
      // Update listings
      if (listings.length > 0) {
        try {
          await this.assetsService.markAssetsAsListedWithPrices(
            listingAssetInfos.map(info => ({
              assetId: info.assetId,
              price: info.price,
              market: 'wayup',
              txHash: result.txHash,
            }))
          );
          this.logger.log(`Marked ${listingAssetInfos.length} asset(s) as LISTED`);
        } catch (statusError) {
          this.logger.warn(`Failed to update asset statuses to LISTED: ${statusError.message}`);
        }
      }

      // Update unlistings
      if (unlistings.length > 0) {
        try {
          await this.assetsService.markAssetsAsUnlisted(unlistedAssetIds);
          this.logger.log(`Marked ${unlistedAssetIds.length} asset(s) as EXTRACTED (unlisted)`);
        } catch (statusError) {
          this.logger.warn(`Failed to update asset statuses to EXTRACTED: ${statusError.message}`);
        }
      }

      // Update listing prices
      if (updates.length > 0) {
        try {
          await this.assetsService.updateListingPrices(
            updateAssetInfos.map(info => ({
              assetId: info.assetId,
              newPrice: info.newPrice,
              txHash: result.txHash,
            }))
          );
          this.logger.log(`Updated listing prices for ${updateAssetInfos.length} asset(s)`);
        } catch (statusError) {
          this.logger.warn(`Failed to update listing prices: ${statusError.message}`);
        }
      }

      // Emit combined event for tracking
      this.eventEmitter.emit('proposal.wayup.combined.completed', {
        proposalId: proposal.id,
        vaultId: proposal.vaultId,
        txHash: result.txHash,
        summary: result.summary,
      });

      return true;
    } catch (error) {
      this.logger.error(`Error executing marketplace proposal ${proposal.id}: ${error.message}`, error.stack);

      // Check if the error is "Listing not found" - this happens when NFT was already bought
      // In this case, we should reject the proposal instead of leaving it for retry
      const errorMessage = error.message || '';
      if (errorMessage.includes('Listing not found') || errorMessage.includes('"code":"NOT_FOUND"')) {
        this.logger.warn(
          `Marketplace proposal ${proposal.id} rejected: Listing not found - NFT was likely already purchased`
        );

        // Store execution error before rejecting so users can see the reason
        await this.storeExecutionError(
          proposal,
          new Error('Listing not found - NFT was likely already purchased or unlisted')
        );

        await this.proposalRepository.update({ id: proposal.id }, { status: ProposalStatus.REJECTED });

        this.eventEmitter.emit('proposal.rejected', {
          address: proposal.vault?.owner?.address || null,
          vaultId: proposal.vaultId,
          vaultName: proposal.vault?.name || null,
          proposalName: proposal.title,
          creatorId: proposal.creatorId,
          tokenHolderIds: [],
          reason: 'Listing not found - NFT was likely already purchased or unlisted',
        });

        // Throw a specific error so processProposal knows the proposal was already handled
        throw new Error('PROPOSAL_REJECTED_LISTING_NOT_FOUND');
      }

      // Store execution error in proposal metadata
      await this.storeExecutionError(proposal, error);

      return false;
    }
  }

  /**
   * Execute DexHunter FT swap proposal
   * Swaps fungible tokens to ADA via DexHunter DEX aggregator
   * Only runs on mainnet - testnet bypasses execution
   * Handles idempotency and assets already in treasury wallet
   */
  private async executeDexHunterSwapProposal(proposal: Proposal): Promise<boolean> {
    // Testnet bypass - DexHunter doesn't support testnet
    if (!this.isMainnet) {
      this.logger.log(
        `[TESTNET] DexHunter swap proposal ${proposal.id} marked as completed (no actual execution on testnet)`
      );
      return true;
    }

    const actions = proposal.metadata.marketplaceActions || [];

    try {
      // Fetch all FT assets from database
      const assetIds = [...new Set(actions.map(opt => opt.assetId))];
      const assets = await this.assetRepository.find({
        where: assetIds.map(id => ({ id })),
        select: ['id', 'policy_id', 'asset_id', 'name', 'quantity', 'type'],
      });

      const assetMap = new Map(assets.map(asset => [asset.id, asset]));

      // Verify treasury wallet exists
      if (!proposal.vault.treasury_wallet?.treasury_address) {
        throw new Error(`Treasury wallet not configured for vault ${proposal.vaultId}`);
      }

      const treasuryAddress = proposal.vault.treasury_wallet.treasury_address;

      // Check which assets are already in treasury wallet
      this.logger.log(`Checking treasury wallet ${treasuryAddress} for existing assets`);
      const tokensInTreasury = new Set<string>();

      try {
        const treasuryAddressInfo = await this.blockfrost.addresses(treasuryAddress);

        for (const amount of treasuryAddressInfo.amount) {
          if (amount.unit !== 'lovelace') {
            tokensInTreasury.add(amount.unit);
          }
        }
      } catch (error) {
        // If treasury wallet has never received transactions, Blockfrost returns 404
        // Treat this as an empty wallet
        if (error.status_code === 404 || error.message?.includes('not been found')) {
          this.logger.log(`Treasury wallet ${treasuryAddress} is empty (no transactions yet)`);
        } else {
          // Re-throw unexpected errors
          throw error;
        }
      }

      // Filter assets that need extraction (not already in treasury)
      const assetsNeedingExtraction = assets.filter(asset => {
        const tokenUnit = asset.policy_id + asset.asset_id;
        return !tokensInTreasury.has(tokenUnit);
      });

      // Extract assets that are not yet in treasury wallet
      if (assetsNeedingExtraction.length > 0) {
        this.logger.log(
          `Extracting ${assetsNeedingExtraction.length} assets to treasury (${assets.length - assetsNeedingExtraction.length} already there)`
        );

        const extractionResult = await this.treasuryExtractionService.extractAssetsFromVault({
          vaultId: proposal.vaultId,
          assetIds: assetsNeedingExtraction.map(a => a.id),
          treasuryAddress,
          isBurn: false,
          skipOnchain: false,
        });

        // Wait for extraction confirmation
        const confirmed = await this.transactionsService.waitForTransactionStatus(
          extractionResult.transactionId,
          TransactionStatus.confirmed
        );

        if (!confirmed) {
          throw new Error(`Extraction transaction ${extractionResult.txHash} not confirmed within timeout`);
        }

        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for blockchain sync
      } else {
        this.logger.log('All assets already in treasury wallet, skipping extraction');
      }

      // Initialize swap results array if not exists
      if (!proposal.metadata.swapResults) {
        proposal.metadata.swapResults = [];
      }

      // Execute swaps sequentially for each token
      const swapResults: Array<{
        actionIndex?: number;
        assetId?: string;
        tokenName?: string;
        tokenUnit?: string;
        totalSwapped?: number;
        txHash: string;
        estimatedOutput: number;
        actualSlippage?: number;
        affectedAssets?: Array<{
          id: string;
          name: string;
          swappedQuantity: number;
          remainingQuantity: number;
        }>;
      }> = [...proposal.metadata.swapResults];

      for (const action of actions) {
        // Check if this swap was already completed (idempotency)
        const alreadySwapped = swapResults.some(r => r.actionIndex === actions.indexOf(action));
        if (alreadySwapped) {
          this.logger.log(`Swap action ${actions.indexOf(action)} already completed, skipping`);
          continue;
        }

        const asset = assetMap.get(action.assetId);
        if (!asset) {
          this.logger.warn(`Asset ${action.assetId} not found, skipping swap`);
          continue;
        }

        const tokenIn = asset.policy_id + asset.asset_id;
        const requestedAmount = parseFloat(action.quantity || asset.quantity.toString());
        const slippage = action.slippage || 0.5;

        // Find all assets of this token to handle multi-asset swaps
        const sameTokenAssets = assets
          .filter(a => a.policy_id === asset.policy_id && a.asset_id === asset.asset_id)
          .sort((a, b) => a.quantity - b.quantity); // Start with smaller quantities (FIFO-ish)

        let remainingToSwap = requestedAmount;
        const affectedAssets: Array<{
          id: string;
          name: string;
          swappedQuantity: number;
          remainingQuantity: number;
        }> = [];

        // Calculate how much to take from each asset
        for (const assetInstance of sameTokenAssets) {
          if (remainingToSwap <= 0) break;

          const takeFromThis = Math.min(remainingToSwap, assetInstance.quantity);
          const newQuantity = assetInstance.quantity - takeFromThis;

          affectedAssets.push({
            id: assetInstance.id,
            name: assetInstance.name || 'Unknown Token',
            swappedQuantity: takeFromThis,
            remainingQuantity: newQuantity,
          });

          remainingToSwap -= takeFromThis;
        }

        this.logger.log(
          `Swapping ${requestedAmount} of ${asset.name} (${tokenIn}) across ${affectedAssets.length} asset(s) with ${slippage}% slippage`
        );

        const swapResult = await this.dexHunterService.executeSwap(proposal.vaultId, {
          tokenIn,
          amountIn: requestedAmount,
          slippage,
        });

        this.logger.log(`Swap completed: ${swapResult.txHash}, output: ${swapResult.estimatedOutput} ADA`);

        // Update each affected asset in the database
        for (const affected of affectedAssets) {
          await this.assetRepository.update(
            { id: affected.id },
            {
              quantity: affected.remainingQuantity,
              status: affected.remainingQuantity === 0 ? AssetStatus.EXTRACTED : AssetStatus.LOCKED,
            }
          );
          this.logger.log(
            `Updated asset ${affected.id}: swapped ${affected.swappedQuantity}, remaining ${affected.remainingQuantity}`
          );
        }

        // Store detailed swap result (keeping backward compatibility with assetId field)
        swapResults.push({
          assetId: action.assetId, // Keep for backward compatibility
          actionIndex: actions.indexOf(action),
          tokenName: asset.name || 'Unknown Token',
          tokenUnit: tokenIn,
          totalSwapped: requestedAmount,
          txHash: swapResult.txHash,
          estimatedOutput: swapResult.estimatedOutput,
          actualSlippage: swapResult.actualSlippage,
          affectedAssets: affectedAssets,
        } as any);

        // Save progress after each swap for idempotency
        proposal.metadata.swapResults = swapResults as any;
        await this.proposalRepository.save(proposal);
      }

      this.logger.log(`DexHunter swap proposal ${proposal.id} completed successfully with ${swapResults.length} swaps`);

      return true;
    } catch (error) {
      this.logger.error(`Error executing DexHunter swap proposal ${proposal.id}: ${error.message}`, error.stack);

      // Handle pool_not_found error on retry - this means token has no liquidity
      const isRetry = proposal.metadata._executionRetry && proposal.metadata._executionRetry.count > 0;
      const isPoolNotFound =
        error.message?.toLowerCase().includes('pool_not_found') ||
        error.message?.toLowerCase().includes('pool not found') ||
        error.message?.toLowerCase().includes('no liquidity');

      if (isRetry && isPoolNotFound) {
        this.logger.warn(
          `Proposal ${proposal.id} retry failed with pool_not_found - marking as REJECTED. ` +
            `Token no longer has sufficient liquidity for swap.`
        );

        proposal.status = ProposalStatus.REJECTED;
        proposal.metadata.executionError = {
          message: error.message,
          timestamp: new Date().toISOString(),
          errorCode: 'POOL_NOT_FOUND',
          userFriendlyMessage:
            'This swap proposal was rejected because the token no longer has sufficient ' +
            'liquidity on any DEX. The token may have been delisted or the liquidity pool removed.',
        };

        await this.proposalRepository.save(proposal);

        this.logger.log(`Proposal ${proposal.id} marked as REJECTED due to insufficient liquidity`);
        return false;
      }

      await this.storeExecutionError(proposal, error);
      return false;
    }
  }

  /**
   * Group market operations by market and action type for batched execution
   */
  private groupBuySellOperations(options: MarketplaceActionDto[]): Record<
    string,
    {
      sells: MarketplaceActionDto[];
      buys: MarketplaceActionDto[];
      unlists: MarketplaceActionDto[];
      updates: MarketplaceActionDto[];
    }
  > {
    const grouped: Record<
      string,
      {
        sells: MarketplaceActionDto[];
        buys: MarketplaceActionDto[];
        unlists: MarketplaceActionDto[];
        updates: MarketplaceActionDto[];
      }
    > = {};

    for (const option of options) {
      const market = (option.market || 'wayup').toLowerCase(); // Normalize to lowercase
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
      return true;
    } catch (error) {
      this.logger.error(`Error executing staking proposal ${proposal.id}: ${error.message}`, error.stack);
      await this.storeExecutionError(proposal, error);
      throw error;
    }
  }

  /**
   * Execute DISTRIBUTION proposal actions
   * Distributes ADA from treasury wallet to VT holders proportionally
   * Uses batched transactions to handle large numbers of recipients
   */
  private async executeDistributionProposal(proposal: Proposal): Promise<boolean> {
    const networkLabel = this.isMainnet ? 'MAINNET' : 'TESTNET';
    this.logger.log(`[${networkLabel}] Executing distribution proposal ${proposal.id}`);

    if (!proposal.metadata.distributionLovelaceAmount) {
      this.logger.warn(`Distribution proposal ${proposal.id} has no lovelace amount to distribute`);
      return false;
    }

    try {
      // Execute the distribution via DistributionService
      const success = await this.distributionService.executeDistribution(proposal);

      if (success) {
        this.logger.log(`Successfully executed distribution proposal ${proposal.id}`);
      } else {
        // Check if there are pending retries
        const status = await this.distributionService.getDistributionStatus(proposal.id);

        if (status.pendingRetry > 0) {
          this.logger.warn(
            `Distribution proposal ${proposal.id} has ${status.pendingRetry} batches pending retry. ` +
              `Will be retried automatically.`
          );
          // Don't fail the proposal if there are pending retries
          return true;
        }

        if (status.failedBatches > 0 && status.completedBatches > 0) {
          // Partial success - some batches completed
          this.logger.warn(
            `Distribution proposal ${proposal.id} partially completed: ` +
              `${status.completedBatches}/${status.totalBatches} batches succeeded, ` +
              `${status.failedBatches} failed after max retries`
          );

          // Emit partial completion event
          this.eventEmitter.emit('proposal.distribution.partial', {
            proposalId: proposal.id,
            vaultId: proposal.vaultId,
            completedBatches: status.completedBatches,
            failedBatches: status.failedBatches,
            totalDistributed: status.totalDistributed,
            network: networkLabel.toLowerCase(),
          });

          // Consider partial success as overall success
          return true;
        }
      }

      return success;
    } catch (error) {
      this.logger.error(`Error executing distribution proposal ${proposal.id}: ${error.message}`, error.stack);
      await this.storeExecutionError(proposal, error);
      throw error;
    }
  }

  /**
   * Execute BURNING proposal actions
   * Extracts selected assets directly to burn wallet
   */
  private async executeBurningProposal(proposal: Proposal): Promise<boolean> {
    const burnWallet = this.isMainnet ? this.BURN_WALLET_MAINNET : this.BURN_WALLET_TESTNET;
    const networkLabel = this.isMainnet ? 'MAINNET' : 'TESTNET';

    this.logger.log(
      `[${networkLabel}] Executing burning proposal ${proposal.id} - extracting assets to burn wallet ${burnWallet}`
    );

    if (!proposal.metadata.burnAssets || proposal.metadata.burnAssets.length === 0) {
      this.logger.warn(`Burning proposal ${proposal.id} has no assets to burn`);
      return false;
    }

    const assetIds = proposal.metadata.burnAssets;
    this.logger.log(`Burning ${assetIds.length} asset(s) from vault ${proposal.vaultId}`);

    try {
      // Validate that all assets are in LOCKED status
      const assets = await this.assetRepository.find({
        where: { id: In(assetIds) },
        select: ['id', 'status', 'name'],
      });

      const notLockedAssets = assets.filter(asset => asset.status !== AssetStatus.LOCKED);

      if (notLockedAssets.length > 0) {
        const rejectionReason = `Assets not in LOCKED status: ${notLockedAssets.map(a => a.name || a.id).join(', ')}`;
        this.logger.warn(
          `Burning proposal ${proposal.id} rejected: ${notLockedAssets.length} asset(s) are not in LOCKED status`
        );

        // Store execution error before rejecting so users can see the reason
        await this.storeExecutionError(proposal, new Error(rejectionReason));

        // Get contributor claims for event
        const finalContributorClaims = await this.claimRepository.find({
          where: {
            vault: { id: proposal.vaultId },
            type: ClaimType.CONTRIBUTOR,
          },
          relations: ['transaction', 'transaction.assets'],
          order: { created_at: 'ASC' },
        });

        // Move proposal to REJECTED status
        await this.proposalRepository.update({ id: proposal.id }, { status: ProposalStatus.REJECTED });

        this.eventEmitter.emit('proposal.rejected', {
          address: proposal.vault?.owner?.address || null,
          vaultId: proposal.vaultId,
          vaultName: proposal.vault?.name || null,
          proposalName: proposal.title,
          creatorId: proposal.creatorId,
          tokenHolderIds: [...new Set(finalContributorClaims.map(c => c.user_id))],
          reason: rejectionReason,
        });

        throw new Error('PROPOSAL_REJECTED_ASSETS_NOT_LOCKED');
      }

      const extractionResult = await this.treasuryExtractionService.extractAssetsFromVault({
        vaultId: proposal.vaultId,
        assetIds: assetIds,
        treasuryAddress: burnWallet,
        skipOnchain: true, // Allow Burning on testnet
        isBurn: true,
      });

      this.logger.log(
        `Successfully extracted ${extractionResult.extractedAssets.length} assets to burn wallet in transaction ${extractionResult.txHash}`
      );

      // Update assets status to BURNED
      await this.assetRepository.update({ id: In(assetIds) }, { status: AssetStatus.BURNED });

      // Emit event for tracking
      this.eventEmitter.emit('proposal.burning.executed', {
        proposalId: proposal.id,
        vaultId: proposal.vaultId,
        assetIds: assetIds,
        burnWallet: burnWallet,
        txHash: extractionResult.txHash,
        network: networkLabel.toLowerCase(),
      });

      this.logger.log(`Successfully executed burning proposal ${proposal.id}`);
      return true;
    } catch (error) {
      this.logger.error(`Error executing burning proposal ${proposal.id}: ${error.message}`, error.stack);
      await this.storeExecutionError(proposal, error);
      throw error;
    }
  }

  /**
   * Execute TERMINATION proposal actions
   * Initiates the vault termination flow:
   * 1. NFTs burn
   * 2. LP removal (VyFi)
   * 3. VT burn (from LP return)
   * 4. ADA to treasury
   * 5. Create termination claims for VT holders
   * 6. Users claim VT -> ADA
   * 7. Vault NFT burn
   * 8. Treasury cleanup
   *
   * Note: Returns false to keep proposal in PASSED status during the multi-step process.
   * Proposal will be marked as EXECUTED only after step 9 completes via event listener.
   */
  private async executeTerminationProposal(proposal: Proposal): Promise<boolean> {
    const networkLabel = this.isMainnet ? 'MAINNET' : 'TESTNET';

    this.logger.log(`[${networkLabel}] Executing termination proposal ${proposal.id} for vault ${proposal.vaultId}`);

    try {
      // Initiate the termination flow via TerminationService
      await this.terminationService.initiateTermination(proposal.vaultId, proposal.id);

      // Emit event for tracking
      this.eventEmitter.emit('proposal.termination.initiated', {
        proposalId: proposal.id,
        vaultId: proposal.vaultId,
        network: networkLabel.toLowerCase(),
      });

      this.logger.log(`Successfully initiated termination for vault ${proposal.vaultId}`);

      // Return false to keep proposal in PASSED status during the multi-step termination process
      // It will be marked as EXECUTED after treasury cleanup completes
      return false;
    } catch (error) {
      this.logger.error(`Error executing termination proposal ${proposal.id}: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Store execution error in proposal metadata
   * Tracks error details including message, timestamp, error code, user-friendly message, and attempt count
   */
  private async storeExecutionError(proposal: Proposal, error: Error): Promise<void> {
    try {
      const metadata = proposal.metadata || {};

      // Categorize error and assign error code
      const errorCode = this.categorizeError(error);

      // Get user-friendly error message
      const userFriendlyMessage = this.getUserFriendlyErrorMessage(errorCode);

      // Create execution error object
      const executionError = {
        message: error.message || 'Unknown error',
        userFriendlyMessage,
        timestamp: new Date().toISOString(),
        errorCode,
      };

      // Update proposal metadata
      await this.proposalRepository.update(
        { id: proposal.id },
        {
          metadata: {
            ...metadata,
            executionError,
          },
        }
      );

      this.logger.log(`Stored execution error for proposal ${proposal.id}: [${errorCode}] ${userFriendlyMessage}`);
    } catch (metadataError) {
      this.logger.error(
        `Failed to store execution error for proposal ${proposal.id}: ${metadataError.message}`,
        metadataError.stack
      );
    }
  }

  /**
   * Get user-friendly error message for error codes
   */
  private getUserFriendlyErrorMessage(errorCode: string): string {
    const errorMessages: Record<string, string> = {
      INSUFFICIENT_FUNDS: 'Insufficient ADA in treasury to cover transaction fees.',
      ASSET_NOT_AVAILABLE: 'Assets no longer available or already sold.',
      ASSET_ALREADY_LISTED: 'Assets already listed on marketplace. Unlist them first.',
      POOL_NOT_FOUND: 'Token has no liquidity pool on any DEX. Token may be delisted or liquidity removed.',
      NETWORK_ERROR: 'Network error. Will retry automatically.',
      API_ERROR: 'External API error. Will retry automatically.',
      TRANSACTION_ERROR: 'Transaction failed to submit. Will retry automatically.',
      WALLET_ERROR: 'Error accessing treasury wallet. Check configuration.',
      INVALID_ASSET_STATUS: 'Assets must be locked in vault first.',
      CONTRACT_ERROR: 'Smart contract validation error.',
      EXECUTION_ERROR: 'Unexpected error. Review details or contact support.',
    };

    return errorMessages[errorCode] || errorMessages.EXECUTION_ERROR;
  }

  /**
   * Categorize error and assign appropriate error code
   */
  private categorizeError(error: Error): string {
    const errorMessage = error.message || '';
    const errorStack = error.stack || '';

    // Insufficient funds errors
    if (
      errorMessage.toLowerCase().includes('insufficient') ||
      errorMessage.toLowerCase().includes('not enough ada') ||
      errorMessage.toLowerCase().includes('utxo balance insufficient') ||
      errorMessage.includes('MIN_UTXO')
    ) {
      return 'INSUFFICIENT_FUNDS';
    }

    // Asset already sold/not found errors
    if (
      errorMessage.includes('Listing not found') ||
      errorMessage.includes('"code":"NOT_FOUND"') ||
      errorMessage.toLowerCase().includes('already sold') ||
      errorMessage.toLowerCase().includes('asset not found')
    ) {
      return 'ASSET_NOT_AVAILABLE';
    }

    // DexHunter pool not found errors (no liquidity)
    if (
      errorMessage.toLowerCase().includes('pool_not_found') ||
      errorMessage.toLowerCase().includes('pool not found') ||
      errorMessage.toLowerCase().includes('no liquidity')
    ) {
      return 'POOL_NOT_FOUND';
    }

    // Asset already listed
    if (errorMessage.includes('already listed') || errorMessage.includes('ALREADY_LISTED')) {
      return 'ASSET_ALREADY_LISTED';
    }

    // Network/API errors
    if (
      errorMessage.toLowerCase().includes('network') ||
      errorMessage.toLowerCase().includes('timeout') ||
      errorMessage.toLowerCase().includes('fetch failed') ||
      errorMessage.toLowerCase().includes('econnrefused') ||
      errorMessage.toLowerCase().includes('enotfound') ||
      errorStack.toLowerCase().includes('fetch')
    ) {
      return 'NETWORK_ERROR';
    }

    // Blockfrost API errors
    if (
      errorMessage.toLowerCase().includes('blockfrost') ||
      errorMessage.toLowerCase().includes('api error') ||
      errorMessage.includes('rate limit')
    ) {
      return 'API_ERROR';
    }

    // Transaction errors
    if (
      errorMessage.toLowerCase().includes('transaction') ||
      errorMessage.toLowerCase().includes('tx ') ||
      errorMessage.toLowerCase().includes('not confirmed') ||
      errorMessage.toLowerCase().includes('failed to submit')
    ) {
      return 'TRANSACTION_ERROR';
    }

    // Treasury/Wallet errors
    if (
      errorMessage.toLowerCase().includes('treasury') ||
      errorMessage.toLowerCase().includes('wallet') ||
      errorMessage.toLowerCase().includes('address')
    ) {
      return 'WALLET_ERROR';
    }

    // Asset status errors
    if (
      errorMessage.toLowerCase().includes('not locked') ||
      errorMessage.toLowerCase().includes('invalid status') ||
      errorMessage.includes('ASSETS_NOT_LOCKED')
    ) {
      return 'INVALID_ASSET_STATUS';
    }

    // Contract/Smart contract errors
    if (
      errorMessage.toLowerCase().includes('script') ||
      errorMessage.toLowerCase().includes('contract') ||
      errorMessage.toLowerCase().includes('datum')
    ) {
      return 'CONTRACT_ERROR';
    }

    // Default to generic execution error
    return 'EXECUTION_ERROR';
  }

  onModuleDestroy(): void {
    // Clean up all proposal-related cron jobs
    this.schedulerService.cleanupAllJobs();
  }
}
