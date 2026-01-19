import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ExecType, MarketplaceActionDto } from './dto/create-proposal.req';
import { ProposalSchedulerService } from './proposal-scheduler.service';
import { VoteCountingService } from './vote-counting.service';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { Proposal } from '@/database/proposal.entity';
import { AssetsService } from '@/modules/vaults/assets/assets.service';
import { TransactionsService } from '@/modules/vaults/processing-tx/offchain-tx/transactions.service';
import { TreasuryExtractionService } from '@/modules/vaults/treasure/treasury-extraction.service';
import { WayUpService } from '@/modules/wayup/wayup.service';
import { ClaimType } from '@/types/claim.types';
import { ProposalStatus, ProposalType } from '@/types/proposal.types';
import { TransactionStatus } from '@/types/transaction.types';

@Injectable()
export class GovernanceExecutionService {
  private readonly logger = new Logger(GovernanceExecutionService.name);
  private readonly isMainnet: boolean;
  private readonly blockfrost: BlockFrostAPI;

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
    private readonly transactionsService: TransactionsService
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
      await this.proposalRepository.update({ id: proposalId }, { status: ProposalStatus.PASSED });

      this.eventEmitter.emit('proposal.passed', {
        address: proposal.vault?.owner?.address || null,
        vaultId: proposal.vaultId,
        vaultName: proposal.vault?.name || null,
        proposalName: proposal.title,
        creatorId: proposal.creatorId,
        tokenHolderIds: [...new Set(finalContributorClaims.map(c => c.user_id))],
      });

      this.logger.log(
        `Proposal ${proposal.id}: PASSED (participation: ${voteResult.participationPercent.toFixed(2)}%, yes votes: ${voteResult.yesVotePercent.toFixed(2)}%, thresholds: ${participationThreshold}%/${executionThreshold}%)`
      );
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
    try {
      const proposal = await this.proposalRepository
        .createQueryBuilder('proposal')
        .leftJoinAndSelect('proposal.vault', 'vault')
        .leftJoinAndSelect('vault.owner', 'owner')
        .leftJoinAndSelect('vault.treasury_wallet', 'treasury_wallet')
        .where('proposal.id = :proposalId', { proposalId })
        .andWhere('proposal.status = :status', { status: ProposalStatus.PASSED })
        .select([
          'proposal.id',
          'proposal.vaultId',
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
        await this.proposalRepository.update(
          { id: proposalId },
          { status: ProposalStatus.EXECUTED, executionDate: new Date() }
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
        this.logger.warn(`Proposal ${proposal.id} execution failed, status remains PASSED for retry`);
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
      this.logger.log(`Executing actions for proposal ${proposal.id} of type ${proposal.proposalType}`);

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
          this.logger.log(`Burning proposal ${proposal.id} - execution logic to be implemented`);
          break;

        case ProposalType.TERMINATION:
          this.logger.log(`Termination proposal ${proposal.id} - execution logic to be implemented`);
          break;

        default:
          this.logger.warn(`Unknown proposal type: ${proposal.proposalType}`);
          return false;
      }
      this.eventEmitter.emit('proposal.started', {
        address: proposal.vault?.owner?.address || null,
        vaultId: proposal.vaultId,
        vaultName: proposal.vault?.name || null,
        proposalName: proposal.title,
        creatorId: proposal.creatorId,
        tokenHolderIds: [...new Set(finalContributorClaims.map(c => c.user_id))],
      });

      return true;
    } catch (error) {
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
   * Execute Marketplace proposal actions via WayUp marketplace
   * Executes all marketplace operations (list, unlist, update, buy) in a single atomic transaction
   * Only runs on mainnet - testnet just logs completion
   */
  private async executeMarketplaceProposal(proposal: Proposal): Promise<boolean> {
    if (!this.isMainnet) {
      this.logger.log(
        `[TESTNET] BUY_SELL proposal ${proposal.id} marked as completed (no actual execution on testnet)`
      );
      return true;
    }

    if (!proposal.metadata.marketplaceActions || proposal.metadata.marketplaceActions.length === 0) {
      this.logger.warn(`BUY_SELL proposal ${proposal.id} has no marketplace options`);
      return false;
    }

    this.logger.log(
      `Executing ${proposal.metadata.marketplaceActions.length} market operation(s) for proposal ${proposal.id}`
    );

    // Collect all unique asset IDs to fetch from database
    const assetIds = [...new Set(proposal.metadata.marketplaceActions.map(opt => opt.assetId))];

    // Fetch all assets from database in one query
    const assets: Pick<Asset, 'id' | 'policy_id' | 'asset_id' | 'name' | 'metadata' | 'listing_tx_hash'>[] =
      await this.assetRepository.find({
        where: assetIds.map(id => ({ id })),
        select: ['id', 'policy_id', 'asset_id', 'name', 'metadata', 'listing_tx_hash'],
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
        const priceAda = parseFloat(option.price);

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
          // If treasury is empty or query fails, assume no assets are there
          this.logger.log(`Treasury wallet appears empty or query failed: ${error.message}`);
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

          const extractionResult = await this.treasuryExtractionService.extractAssetsToTreasury({
            vaultId: proposal.vaultId,
            assetIds: assetsNeedingExtraction,
            treasuryAddress,
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

        await this.proposalRepository.update({ id: proposal.id }, { status: ProposalStatus.REJECTED });

        this.eventEmitter.emit('proposal.rejected', {
          address: proposal.vault?.owner?.address || null,
          vaultId: proposal.vaultId,
          vaultName: proposal.vault?.name || null,
          proposalName: proposal.title,
          creatorId: proposal.creatorId,
          tokenHolderIds: [],
          reason: 'Listing not found - NFT was likely already purchased',
        });

        // Throw a specific error so processProposal knows the proposal was already handled
        throw new Error('PROPOSAL_REJECTED_LISTING_NOT_FOUND');
      }

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

  onModuleDestroy(): void {
    // Clean up all proposal-related cron jobs
    this.schedulerService.cleanupAllJobs();
  }
}
