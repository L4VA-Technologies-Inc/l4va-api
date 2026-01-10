import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import NodeCache from 'node-cache';
import { In, IsNull, Not, Repository } from 'typeorm';

import { CreateProposalReq } from './dto/create-proposal.req';
import { CreateProposalRes } from './dto/create-proposal.res';
import { AssetBuySellDto } from './dto/get-assets.dto';
import { GetProposalDetailRes } from './dto/get-proposal-detail.res';
import { GetProposalsResItem } from './dto/get-proposal.dto';
import { VoteReq } from './dto/vote.req';
import { VoteRes } from './dto/vote.res';
import { VoteCountingService } from './vote-counting.service';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { Proposal } from '@/database/proposal.entity';
import { Snapshot } from '@/database/snapshot.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { Vote } from '@/database/vote.entity';
import { AssetStatus, AssetType } from '@/types/asset.types';
import { ClaimStatus, ClaimType } from '@/types/claim.types';
import { ProposalStatus, ProposalType } from '@/types/proposal.types';
import { VaultStatus } from '@/types/vault.types';
import { VoteType } from '@/types/vote.types';

/*
        .-""""-.
       / -   -  \
      |  .-. .- |
      |  \o| |o (
      \     ^    \
       '.  )--'  /
         '-...-'`
    BLOCKCHAIN COUNCIL
    { } { } { } { } { }
     |   |   |   |   |
    /     VOTING     \
   /-------------------\
  |  YES   NO  ABSTAIN |
  |   |     |     |    |
  |  [X]   [ ]   [ ]   |
   \__________________/
      /   |   |   \
     /    |   |    \
    /     |   |     \
   /      |   |      \
  /_______|___|_______\

*/

@Injectable()
export class GovernanceService {
  private readonly logger = new Logger(GovernanceService.name);
  private blockfrost: BlockFrostAPI;
  private readonly votingPowerCache: NodeCache;
  private readonly proposalCreationCache: NodeCache;
  private readonly poolAddress: string;

  // private readonly snapshotCache: NodeCache;

  private readonly CACHE_TTL = {
    VOTING_POWER: 300, // 5 minutes - for general voting power checks
    CAN_CREATE_PROPOSAL: 1800, // 30 minutes - for canCreateProposal checks
    SNAPSHOT_DATA: 1800, // 30 minutes - for snapshot data
    NO_VOTING_POWER: 600, // 10 minutes - cache negative results longer to reduce spam
    PROPOSAL_DATA: 120, // 2 minutes - for proposal-specific data
  };

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Snapshot)
    private readonly snapshotRepository: Repository<Snapshot>,
    @InjectRepository(Proposal)
    private readonly proposalRepository: Repository<Proposal>,
    @InjectRepository(Claim)
    private readonly claimRepository: Repository<Claim>,
    @InjectRepository(Vote)
    private readonly voteRepository: Repository<Vote>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly voteCountingService: VoteCountingService
  ) {
    this.poolAddress = this.configService.get<string>('POOL_ADDRESS');

    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });
    this.votingPowerCache = new NodeCache({
      stdTTL: this.CACHE_TTL.VOTING_POWER,
      checkperiod: 120,
      useClones: false,
    });

    this.proposalCreationCache = new NodeCache({
      stdTTL: this.CACHE_TTL.CAN_CREATE_PROPOSAL,
      checkperiod: 300,
      useClones: false,
    });

    // this.snapshotCache = new NodeCache({
    //   stdTTL: this.CACHE_TTL.SNAPSHOT_DATA,
    //   checkperiod: 600,
    //   useClones: false,
    // });
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async createDailySnapshots(): Promise<void> {
    this.logger.log('Starting daily snapshot creation');

    try {
      const lockedVaults = await this.vaultRepository.find({
        where: {
          vault_status: VaultStatus.locked,
          asset_vault_name: Not(IsNull()),
          script_hash: Not(IsNull()),
        },
        select: ['id', 'asset_vault_name', 'script_hash'],
      });

      if (lockedVaults.length === 0) {
        this.logger.log('No eligible vaults found for snapshot creation');
        return;
      }

      this.logger.log(`Found ${lockedVaults.length} locked vaults for snapshots`);

      const results = await Promise.allSettled(
        lockedVaults.map(async (vault, index) => {
          if (index > 0) {
            await new Promise(resolve => setTimeout(resolve, 1000)); //  Add delay between requests to avoid overwhelming BlockFrost
          }
          return await this.createAutomaticSnapshot(vault.id, `${vault.script_hash}${vault.asset_vault_name}`);
        })
      );

      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      this.logger.log(`Daily snapshot creation completed: ${successful} successful, ${failed} failed`);
    } catch (error) {
      this.logger.error(`Failed to create daily snapshots: ${error.message}`, error.stack);
    }
  }

  /**
   * Creates an automatic snapshot for a vault.
   * @param vaultId - The ID of the vault
   * @param assetId - Concatenation of the policy ID and hex-encoded asset name
   * @returns - List of a addresses containing a specific asset.
   */
  async createAutomaticSnapshot(vaultId: string, assetId: string): Promise<Snapshot> {
    this.logger.log(`Creating automatic snapshot for vault ${vaultId} with asset ${assetId}`);

    try {
      // First, check if there's at least one claimed contribution or acquisition for this vault
      const claimedContributions = await this.claimRepository.count({
        where: {
          vault: { id: vaultId },
          status: ClaimStatus.CLAIMED,
          type: In([ClaimType.CONTRIBUTOR, ClaimType.ACQUIRER]),
        },
      });

      if (claimedContributions === 0) {
        throw new BadRequestException(
          `No claimed contributions or acquisitions found for vault ${vaultId}. Cannot create snapshot.`
        );
      }

      // Fetch all addresses holding the asset using BlockFrost
      const addressBalances: Record<string, string> = {};
      let page = 1;
      let hasMorePages = true;

      while (hasMorePages) {
        try {
          const response = await this.blockfrost.assetsAddresses(assetId, { page, order: 'desc' });

          if (response.length === 0) {
            hasMorePages = false;
          } else {
            // Add addresses and balances to the mapping, excluding pool address (LP VTs)
            for (const item of response) {
              if (item.address !== this.poolAddress) {
                addressBalances[item.address] = item.quantity;
              } else {
                this.logger.log(`Excluded pool address ${this.poolAddress} from snapshot (${item.quantity} VT in LP)`);
              }
            }
            page++;
          }
        } catch (error) {
          if (error.message.includes('not been found') || error.status_code === 404) {
            this.logger.warn(`Asset ${assetId} not found on blockchain. Verify policy ID and asset name are correct.`);

            if (Object.keys(addressBalances).length === 0) {
              try {
                await this.blockfrost.assetsById(assetId);
              } catch (assetError) {
                this.logger.error(`Asset ${assetId} does not exist on blockchain: ${assetError.message}`);
                throw new NotFoundException(
                  `Asset ${assetId} not found on blockchain. Check policy ID and asset name.`
                );
              }
            }
          }

          // Stop fetching more pages on any error
          hasMorePages = false;
        }
      }

      // Create and save the snapshot
      const snapshot = this.snapshotRepository.create({
        vaultId,
        assetId,
        addressBalances,
      });

      await this.snapshotRepository.save(snapshot);

      this.logger.log(
        `Automatic snapshot created for vault ${vaultId} with ${Object.keys(addressBalances).length} addresses`
      );

      return snapshot;
    } catch (error) {
      this.logger.error(`Failed to create automatic snapshot: ${error.message}`, error.stack);
      throw error;
    }
  }

  async createProposal(
    vaultId: string,
    createProposalReq: CreateProposalReq,
    userId: string
  ): Promise<CreateProposalRes> {
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      select: ['id', 'vault_status', 'policy_id', 'asset_vault_name'],
    });

    if (!vault) {
      throw new NotFoundException('Vault not found');
    }

    if (vault.vault_status !== VaultStatus.locked) {
      throw new BadRequestException('Governance is only available for locked vaults');
    }

    const latestSnapshot = await this.snapshotRepository.findOne({
      where: { vaultId },
      order: { createdAt: 'DESC' },
    });

    await this.getVotingPower(vaultId, userId, 'create_proposal');

    const startDate = new Date(createProposalReq.startDate ?? createProposalReq.proposalStart);

    // Create the proposal with the appropriate fields based on type
    const proposal = this.proposalRepository.create({
      vaultId,
      title: createProposalReq.title,
      description: createProposalReq.description,
      proposalType: createProposalReq.type,
      status: startDate <= new Date() ? ProposalStatus.ACTIVE : ProposalStatus.UPCOMING,
      startDate,
      endDate: new Date(startDate.getTime() + createProposalReq.duration),
      creatorId: userId,
      snapshotId: latestSnapshot.id,
    });

    // Initialize metadata object
    proposal.metadata = {};

    // Set type-specific fields based on proposal type
    switch (createProposalReq.type) {
      case ProposalType.STAKING:
        proposal.metadata.fungibleTokens = createProposalReq.fts || [];
        proposal.metadata.nonFungibleTokens = createProposalReq.nfts || [];
        break;

      case ProposalType.DISTRIBUTION:
        proposal.metadata.distributionAssets = createProposalReq.distributionAssets || [];
        break;

      case ProposalType.TERMINATION:
        if (createProposalReq.metadata) {
          proposal.terminationDate = createProposalReq.metadata.terminationDate
            ? new Date(createProposalReq.metadata.terminationDate)
            : undefined;
        }
        break;

      case ProposalType.BURNING:
        if (createProposalReq.metadata) {
          proposal.metadata.burnAssets = createProposalReq.metadata.burnAssets || [];
        }
        break;

      case ProposalType.BUY_SELL: // Deprecated - use MARKETPLACE_ACTION instead
        if (createProposalReq.metadata) {
          // Prefer the canonical `marketplaceActions` field if present, otherwise fall back to
          // the legacy `buyingSellingOptions` field for backward compatibility.
          proposal.metadata.marketplaceActions =
            createProposalReq.metadata.marketplaceActions ?? createProposalReq.metadata.buyingSellingOptions ?? [];
          proposal.abstain = createProposalReq.metadata.abstain || false;

          for (const option of proposal.metadata.marketplaceActions) {
            const asset = await this.assetRepository.findOne({
              where: { id: option.assetId },
            });

            if (!asset) {
              throw new BadRequestException(`Asset with ID ${option.assetId} not found`);
            }
          }
        }
        break;

      case ProposalType.MARKETPLACE_ACTION: {
        // Use direct marketplaceActions from request body
        const actions = createProposalReq.marketplaceActions || [];

        // Validate all assets exist and enrich with additional data
        proposal.metadata.marketplaceActions = await Promise.all(
          actions.map(async action => {
            const asset = await this.assetRepository.findOne({
              where: { id: action.assetId },
            });

            if (!asset) {
              throw new BadRequestException(`Asset with ID ${action.assetId} not found`);
            }

            // For UNLIST and UPDATE_LISTING, verify asset is currently listed
            if (action.exec === 'UNLIST' || action.exec === 'UPDATE_LISTING') {
              if (asset.status !== 'listed') {
                throw new BadRequestException(`Asset ${action.assetId} is not currently listed`);
              }
            }

            // Return new object with enriched data instead of mutating
            return {
              ...action,
              assetName: asset.name,
              assetImg: asset.image,
              assetPrice: asset.floor_price || asset.dex_price || 0,
            };
          })
        );

        break;
      }
    }

    await this.proposalRepository.save(proposal);

    this.eventEmitter.emit('proposal.created', {
      proposalId: proposal.id,
      startDate: proposal.startDate,
      endDate: proposal.endDate,
      status: proposal.status,
    });

    const user = await this.userRepository.findOneBy({ id: proposal.creatorId });
    const finalContributorClaims = await this.claimRepository.find({
      where: {
        vault: { id: vault.id },
        type: ClaimType.CONTRIBUTOR,
      },
      relations: ['transaction', 'transaction.assets'],
      order: { created_at: 'ASC' },
    });

    this.eventEmitter.emit('governance.proposal_created', {
      address: user.address,
      vaultId: vault.id,
      vaultName: vault.name,
      proposalName: proposal.title,
      creatorId: proposal.creatorId,
    });

    this.eventEmitter.emit('proposal.started', {
      address: user.address,
      vaultId: vault.id,
      vaultName: vault.name,
      proposalName: proposal.title,
      creatorId: proposal.creatorId,
      tokenHolderIds: [...new Set(finalContributorClaims.map(c => c.user_id))],
    });

    return {
      success: true,
      message: 'Proposal created successfully',
      proposal: {
        id: proposal.id,
        vaultId,
        title: proposal.title,
        description: proposal.description,
        creatorId: userId,
        status: proposal.status,
        createdAt: proposal.createdAt,
        endDate: proposal.endDate,
      },
    };
  }

  async getProposals(vaultId: string): Promise<GetProposalsResItem[]> {
    const vaultExists = await this.vaultRepository.exists({
      where: { id: vaultId },
    });

    if (!vaultExists) {
      throw new NotFoundException('Vault not found');
    }

    const proposals = await this.proposalRepository.find({
      where: { vaultId },
      order: { createdAt: 'DESC' },
    });

    // Process each proposal to add vote information
    return await Promise.all(
      proposals.map(async proposal => {
        const baseProposal = {
          id: proposal.id,
          title: proposal.title,
          description: proposal.description,
          creatorId: proposal.creatorId,
          status: proposal.status,
          createdAt: proposal.createdAt,
          endDate: proposal.endDate.toISOString(),
          abstain: proposal.abstain,
        };

        if (proposal.status === ProposalStatus.UPCOMING) {
          return baseProposal;
        }

        try {
          const { votes: voteList, totals } = await this.getVotes(proposal.id);
          const voteResult = this.voteCountingService.calculateResult(voteList, 0, BigInt(totals.totalVotingPower));

          return {
            ...baseProposal,
            votes: {
              yes: voteResult.yesVotePercent,
              no: voteResult.noVotePercent,
              abstain: proposal.abstain ? voteResult.abstainVotePercent : 0,
            },
          };
        } catch (error) {
          this.logger.error(`Error fetching votes for proposal ${proposal.id}: ${error.message}`, error.stack);
          return baseProposal;
        }
      })
    );
  }

  async getProposal(proposalId: string, userId: string): Promise<GetProposalDetailRes> {
    const proposal = await this.proposalRepository.findOne({
      where: { id: proposalId },
    });

    if (!proposal) {
      throw new NotFoundException('Proposal not found');
    }

    const proposer = await this.userRepository.findOne({
      where: { id: proposal.creatorId },
      select: ['id', 'address'],
    });

    const { votes, totals } = await this.getVotes(proposalId);

    let canVote = false;
    let selectedVote: VoteType | null = null;

    try {
      const isActive = proposal.status === ProposalStatus.ACTIVE && new Date() <= proposal.endDate;

      const user = await this.userRepository.findOne({
        where: { id: userId },
        select: ['id', 'address'],
      });

      if (user && user.address) {
        const snapshot = await this.snapshotRepository.findOne({
          where: { id: proposal.snapshotId },
        });

        if (snapshot) {
          const voteWeight = snapshot.addressBalances[user.address];
          const hasVotingPower = voteWeight && voteWeight !== '0';

          const existingVote = await this.voteRepository.findOne({
            where: {
              proposalId,
              voterAddress: user.address,
            },
            select: ['vote'],
          });

          if (existingVote) {
            selectedVote = existingVote.vote;
          } else {
            canVote = isActive && hasVotingPower;
          }
        }
      }
    } catch (error) {
      this.logger.error(
        `Error checking voting eligibility for user ${userId} on proposal ${proposalId}: ${error.message}`
      );
    }

    let burnAssetsWithNames = [];
    if (proposal.metadata.burnAssets && proposal.metadata.burnAssets.length > 0) {
      const burnAssets = await this.assetRepository.find({
        where: { id: In(proposal.metadata.burnAssets) },
        select: ['id', 'policy_id', 'asset_id', 'type', 'quantity', 'image', 'name', 'metadata'],
      });
      burnAssetsWithNames = burnAssets.map(asset => {
        let name = asset.name || asset.metadata?.name;
        if (!name) name = 'Unknown Asset';

        let imageUrl = null;
        const image = asset.image || asset.metadata?.image;
        if (image) {
          imageUrl = image.startsWith('ipfs://') ? image.replace('ipfs://', 'https://ipfs.io/ipfs/') : image;
        }

        return {
          id: asset.id,
          name,
          imageUrl,
          policyId: asset.policy_id,
          assetId: asset.asset_id,
          type: asset.type,
          quantity: asset.quantity,
        };
      });
    }

    let distributionAssetsWithNames = [];
    if (proposal.metadata.distributionAssets && proposal.metadata.distributionAssets.length > 0) {
      const distributionAssetIds = proposal.metadata.distributionAssets.map(da => da.id);
      const distributionAssets = await this.assetRepository.find({
        where: { id: In(distributionAssetIds) },
        select: ['id', 'policy_id', 'asset_id', 'type', 'quantity', 'image', 'name', 'metadata'],
      });

      // Create a map for quick lookup of distribution amounts
      const distributionAmountMap = new Map(proposal.metadata.distributionAssets.map(da => [da.id, da.amount]));

      distributionAssetsWithNames = distributionAssets.map(asset => {
        let name = asset.name || asset.metadata?.name;
        if (!name) name = 'Unknown Asset';

        let imageUrl = null;
        const image = asset.image || asset.metadata?.image;
        if (image) {
          imageUrl = image.startsWith('ipfs://') ? image.replace('ipfs://', 'https://ipfs.io/ipfs/') : image;
        }

        return {
          id: asset.id,
          name,
          imageUrl,
          policyId: asset.policy_id,
          assetId: asset.asset_id,
          type: asset.type,
          quantity: asset.quantity,
          amount: distributionAmountMap.get(asset.id) || 0,
        };
      });
    }

    let fungibleTokensWithNames = [];
    if (proposal.metadata.fungibleTokens && proposal.metadata.fungibleTokens.length > 0) {
      const fungibleTokenIds = proposal.metadata.fungibleTokens.map(ft => ft.id);
      const fungibleTokens = await this.assetRepository.find({
        where: { id: In(fungibleTokenIds) },
        select: ['id', 'policy_id', 'asset_id', 'type', 'quantity', 'image', 'name', 'metadata', 'listing_market'],
      });

      const amountMap = new Map(proposal.metadata.fungibleTokens.map(ft => [ft.id, ft.amount]));

      fungibleTokensWithNames = fungibleTokens.map(asset => {
        let name = asset.name || asset.metadata?.name;
        if (!name) name = 'Unknown Asset';

        let imageUrl = null;
        const image = asset.image || asset.metadata?.image;
        if (image) {
          imageUrl = image.startsWith('ipfs://') ? image.replace('ipfs://', 'https://ipfs.io/ipfs/') : image;
        }

        return {
          id: asset.id,
          name,
          imageUrl,
          policyId: asset.policy_id,
          assetId: asset.asset_id,
          type: asset.type,
          quantity: asset.quantity,
          amount: amountMap.get(asset.id),
        };
      });
    }

    let nonFungibleTokensWithNames = [];
    if (proposal.metadata.nonFungibleTokens && proposal.metadata.nonFungibleTokens.length > 0) {
      const nonFungibleTokenIds = proposal.metadata.nonFungibleTokens.map(nft => nft.id);
      const nonFungibleTokens = await this.assetRepository.find({
        where: { id: In(nonFungibleTokenIds) },
        select: ['id', 'policy_id', 'asset_id', 'type', 'quantity', 'image', 'name', 'metadata', 'listing_market'],
      });

      const marketMap = new Map(proposal.metadata.nonFungibleTokens.map(nft => [nft.id, nft.market]));

      nonFungibleTokensWithNames = nonFungibleTokens.map(asset => {
        let name = asset.name || asset.metadata?.name;
        if (!name) name = 'Unknown Asset';

        let imageUrl = null;
        const image = asset.image || asset.metadata?.image;
        if (image) {
          imageUrl = image.startsWith('ipfs://') ? image.replace('ipfs://', 'https://ipfs.io/ipfs/') : image;
        }

        return {
          id: asset.id,
          name,
          imageUrl,
          policyId: asset.policy_id,
          assetId: asset.asset_id,
          type: asset.type,
          quantity: asset.quantity,
          market: marketMap.get(asset.id),
        };
      });
    }

    return {
      proposal,
      votes,
      totals,
      canVote,
      selectedVote,
      proposer,
      burnAssets: burnAssetsWithNames,
      distributionAssets: distributionAssetsWithNames,
      fungibleTokens: fungibleTokensWithNames,
      nonFungibleTokens: nonFungibleTokensWithNames,
    };
  }

  async vote(proposalId: string, voteReq: VoteReq, userId: string): Promise<VoteRes> {
    const proposal = await this.proposalRepository.findOne({
      where: { id: proposalId },
    });

    if (!proposal) {
      throw new NotFoundException('Proposal not found');
    }

    if (proposal.status !== ProposalStatus.ACTIVE) {
      throw new BadRequestException('Voting is only allowed on active proposals');
    }

    if (new Date() > proposal.endDate) {
      throw new BadRequestException('Voting period has ended');
    }

    if (!proposal.abstain && voteReq.vote === VoteType.ABSTAIN) {
      throw new BadRequestException('Abstain option is not allowed for this proposal');
    }

    // Check if user has already voted
    const existingVote = await this.voteRepository.exists({
      where: {
        proposalId,
        voterAddress: voteReq.voterAddress,
      },
    });

    if (existingVote) {
      throw new BadRequestException('Address has already voted on this proposal');
    }

    const voteWeight = await this.getVotingPower(proposal.vaultId, userId, 'vote');

    const vote = this.voteRepository.create({
      proposalId,
      snapshotId: proposal.snapshotId,
      voterId: userId,
      voterAddress: voteReq.voterAddress,
      voteWeight,
      vote: voteReq.vote,
    });

    await this.voteRepository.save(vote);

    return {
      success: true,
      message: 'Vote recorded successfully',
      vote: {
        id: vote.id,
        proposalId,
        voterId: userId,
        voterAddress: voteReq.voterAddress,
        voteWeight,
        vote: voteReq.vote,
        timestamp: vote.timestamp,
      },
    };
  }

  async getVotes(proposalId: string): Promise<{
    votes: {
      id: string;
      voterAddress: string;
      voteWeight: string;
      vote: VoteType;
      timestamp: Date;
    }[];
    totals: {
      yes: string;
      no: string;
      abstain: string;
      totalVotingPower: string;
      votedPercentage: number;
    };
  }> {
    const proposal = await this.proposalRepository.findOne({
      where: { id: proposalId },
    });

    if (!proposal) {
      throw new NotFoundException('Proposal not found');
    }

    const votes = await this.voteRepository.find({
      where: { proposalId },
      order: { timestamp: 'DESC' },
      select: ['id', 'voterAddress', 'voteWeight', 'vote', 'timestamp'],
    });

    const snapshot = await this.snapshotRepository.findOne({
      where: { id: proposal.snapshotId },
    });

    if (!snapshot) {
      throw new NotFoundException('Snapshot not found');
    }

    const totalVotingPowerBigInt = Object.values(snapshot.addressBalances).reduce(
      (sum, balance) => BigInt(sum) + BigInt(balance),
      BigInt(0)
    );
    const totalVotingPower = totalVotingPowerBigInt.toString();

    // Use vote counting service to calculate all vote totals and percentages
    const voteResult = this.voteCountingService.calculateResult(votes, 0, totalVotingPowerBigInt);

    const totals = {
      yes: voteResult.yesVotes.toString(),
      no: voteResult.noVotes.toString(),
      abstain: voteResult.abstainVotes.toString(),
      totalVotingPower,
      votedPercentage: 0,
    };

    // Calculate the percentage of total voting power that has voted
    const votedVotingPower = voteResult.yesVotes + voteResult.noVotes + voteResult.abstainVotes;
    if (totalVotingPowerBigInt > 0) {
      totals.votedPercentage = Number((votedVotingPower * BigInt(100)) / totalVotingPowerBigInt);
    }

    return {
      votes: votes.map(vote => ({
        id: vote.id,
        voterAddress: vote.voterAddress,
        voteWeight: vote.voteWeight,
        vote: vote.vote,
        timestamp: vote.timestamp,
      })),
      totals,
    };
  }

  async getVotingPower(vaultId: string, userId: string, action?: 'vote' | 'create_proposal'): Promise<string> {
    const cacheKey = `voting_power:${vaultId}:${userId}:${action || 'general'}`;

    // Check cache first
    const cached = this.votingPowerCache.get<{
      power: string;
      error?: { type: string; message: string };
    }>(cacheKey);

    if (cached !== undefined) {
      this.logger.debug(`Cache hit for voting power: ${cacheKey}`);
      if (cached.error) {
        // Re-throw cached error
        if (cached.error.type === 'BadRequestException') {
          throw new BadRequestException(cached.error.message);
        } else if (cached.error.type === 'NotFoundException') {
          throw new NotFoundException(cached.error.message);
        }
      }
      return cached.power;
    }

    try {
      const power = await this._getVotingPowerUncached(vaultId, userId, action);

      // Cache successful result
      this.votingPowerCache.set(cacheKey, { power }, this.CACHE_TTL.VOTING_POWER);

      return power;
    } catch (error) {
      let cacheTTL = this.CACHE_TTL.VOTING_POWER;

      // Cache errors with longer TTL to redce repeated failed calls
      if (error instanceof BadRequestException) {
        if (error.message.includes('NO_VOTING_POWER')) {
          cacheTTL = this.CACHE_TTL.NO_VOTING_POWER;
        }

        this.votingPowerCache.set(
          cacheKey,
          {
            power: '0',
            error: { type: 'BadRequestException', message: error.message },
          },
          cacheTTL
        );

        if (!error.message.includes('NO_VOTING_POWER')) {
          this.logger.warn(`Voting power check failed for ${userId} in vault ${vaultId}: ${error.message}`);
        }
      } else if (error instanceof NotFoundException) {
        this.votingPowerCache.set(
          cacheKey,
          {
            power: '0',
            error: { type: 'NotFoundException', message: error.message },
          },
          cacheTTL
        );

        this.logger.warn(`Voting power check failed for ${userId} in vault ${vaultId}: ${error.message}`);
      } else {
        this.logger.error(`Unexpected error in voting power check for ${userId} in vault ${vaultId}:`, error);
      }

      throw error;
    }
  }

  async getAssetsToStake(vaultId: string): Promise<Asset[]> {
    try {
      return await this.assetRepository.find({
        where: {
          vault: { id: vaultId },
          type: In([AssetType.FT, AssetType.NFT]),
          status: AssetStatus.LOCKED,
        },
      });
    } catch (error) {
      this.logger.error(`Error getting assets to stake for vault ${vaultId}: ${error.message}`, error.stack);
      throw new InternalServerErrorException('Error getting assets to stake');
    }
  }

  /**
   *  Distribute: Should not allow to distribute NFTs.
   */
  async getAssetsToDistribute(vaultId: string): Promise<Asset[]> {
    try {
      return await this.assetRepository.find({
        where: {
          vault: { id: vaultId },
          type: In([AssetType.FT, AssetType.NFT]),
          status: AssetStatus.LOCKED,
        },
        relations: ['vault'],
        select: ['id', 'policy_id', 'asset_id', 'type', 'quantity', 'dex_price', 'floor_price', 'metadata', 'name'],
      });
    } catch (error) {
      this.logger.error(`Error getting assets to stake for vault ${vaultId}: ${error.message}`, error.stack);
      throw new InternalServerErrorException('Error getting assets to stake');
    }
  }

  async getAssetsToTerminate(vaultId: string): Promise<AssetBuySellDto[]> {
    try {
      // Get all assets in the vault eligible for termination
      const assets = await this.assetRepository.find({
        where: {
          vault: { id: vaultId },
          type: In([AssetType.NFT, AssetType.FT]),
          status: AssetStatus.LOCKED,
          deleted: false,
        },
        relations: ['vault'],
        select: ['id', 'policy_id', 'asset_id', 'type', 'quantity', 'dex_price', 'floor_price', 'metadata'],
      });

      return plainToInstance(AssetBuySellDto, assets, {
        excludeExtraneousValues: true,
      });
    } catch (error) {
      this.logger.error(`Error getting assets to terminate for vault ${vaultId}: ${error.message}`, error.stack);
      throw new InternalServerErrorException('Error getting assets to terminate');
    }
  }

  async getAssetsToBurn(vaultId: string): Promise<AssetBuySellDto[]> {
    try {
      const assets = await this.assetRepository.find({
        where: {
          vault: { id: vaultId },
          type: In([AssetType.NFT, AssetType.FT]),
          status: AssetStatus.LOCKED,
          deleted: false,
        },
        relations: ['vault'],
        select: ['id', 'policy_id', 'asset_id', 'type', 'quantity', 'dex_price', 'floor_price', 'metadata'],
      });

      return plainToInstance(AssetBuySellDto, assets, {
        excludeExtraneousValues: true,
      });
    } catch (error) {
      this.logger.error(`Error getting assets to burn for vault ${vaultId}: ${error.message}`, error.stack);
      throw new InternalServerErrorException('Error getting assets to burn');
    }
  }

  async getAssetsToBuySell(vaultId: string): Promise<AssetBuySellDto[]> {
    try {
      // Get all assets in the vault
      const assets: Pick<
        Asset,
        'id' | 'policy_id' | 'quantity' | 'dex_price' | 'floor_price' | 'metadata' | 'type' | 'name' | 'image'
      >[] = await this.assetRepository.find({
        where: [
          { vault: { id: vaultId }, type: AssetType.NFT, status: AssetStatus.LOCKED },
          { vault: { id: vaultId }, type: AssetType.FT, status: AssetStatus.LOCKED },
        ],
        select: [
          'id',
          'policy_id',
          'quantity',
          'dex_price',
          'floor_price',
          'metadata',
          'type',
          'name',
          'image',
          'listing_market',
          'listing_price',
          'listing_tx_hash',
        ],
      });

      return plainToInstance(AssetBuySellDto, assets, {
        excludeExtraneousValues: true,
      });
    } catch (error) {
      this.logger.error(`Error getting assets for buy-sell proposals for vault ${vaultId}: ${error.message}`);
      throw new InternalServerErrorException('Error getting assets for buying/selling');
    }
  }

  async getAssetsToUnlist(vaultId: string): Promise<AssetBuySellDto[]> {
    try {
      // Get all listed assets in the vault
      const assets = await this.assetRepository.find({
        where: [
          { vault: { id: vaultId }, type: AssetType.NFT, status: AssetStatus.LISTED },
          { vault: { id: vaultId }, type: AssetType.FT, status: AssetStatus.LISTED },
        ],
        select: [
          'id',
          'name',
          'policy_id',
          'quantity',
          'dex_price',
          'floor_price',
          'image',
          'metadata',
          'type',
          'listing_market',
          'listing_price',
          'listing_tx_hash',
          'listed_at',
        ],
      });

      return plainToInstance(AssetBuySellDto, assets, {
        excludeExtraneousValues: true,
      });
    } catch (error) {
      this.logger.error(`Error getting assets to unlist for vault ${vaultId}: ${error.message}`);
      throw new InternalServerErrorException('Error getting assets for unlisting');
    }
  }

  async getAssetsToUpdateListing(vaultId: string): Promise<AssetBuySellDto[]> {
    try {
      // Get all listed assets in the vault that can have their listing updated
      const assets = await this.assetRepository.find({
        where: [
          { vault: { id: vaultId }, type: AssetType.NFT, status: AssetStatus.LISTED },
          { vault: { id: vaultId }, type: AssetType.FT, status: AssetStatus.LISTED },
        ],
        select: [
          'id',
          'name',
          'policy_id',
          'quantity',
          'dex_price',
          'floor_price',
          'image',
          'metadata',
          'type',
          'listing_market',
          'listing_price',
          'listing_tx_hash',
          'listed_at',
        ],
      });

      return plainToInstance(AssetBuySellDto, assets, {
        excludeExtraneousValues: true,
      });
    } catch (error) {
      this.logger.error(`Error getting assets to update listing for vault ${vaultId}: ${error.message}`);
      throw new InternalServerErrorException('Error getting assets for updating listings');
    }
  }

  async canUserCreateProposal(vaultId: string, userId: string): Promise<boolean> {
    const cacheKey = `can_create_proposal:${vaultId}:${userId}`;

    const cached = this.proposalCreationCache.get<boolean>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const vault = await this.vaultRepository.findOne({
        where: { id: vaultId },
        select: ['id', 'vault_status'],
      });

      if (!vault || vault.vault_status !== VaultStatus.locked) {
        this.proposalCreationCache.set(cacheKey, false, this.CACHE_TTL.CAN_CREATE_PROPOSAL);
        return false;
      }
      await this.getVotingPower(vaultId, userId, 'create_proposal');
      this.proposalCreationCache.set(cacheKey, true, this.CACHE_TTL.CAN_CREATE_PROPOSAL);
      return true;
    } catch {
      this.proposalCreationCache.set(cacheKey, false, this.CACHE_TTL.CAN_CREATE_PROPOSAL);
      return false;
    }
  }

  private async _getVotingPowerUncached(
    vaultId: string,
    userId: string,
    action?: 'vote' | 'create_proposal'
  ): Promise<string> {
    try {
      const snapshot = await this.snapshotRepository.findOne({
        where: { vaultId },
        order: { createdAt: 'DESC' },
      });

      if (!snapshot) {
        throw new NotFoundException('No voting snapshot found for this vault');
      }

      const vault = await this.vaultRepository.findOne({
        where: { id: vaultId },
        select: ['creation_threshold', 'vote_threshold'],
      });

      if (!vault) {
        throw new NotFoundException('Vault not found');
      }

      const user = await this.userRepository.findOne({
        where: { id: userId },
        select: ['id', 'address'],
      });

      if (!user) {
        throw new NotFoundException('User not found');
      }

      // Verify user is not the pool address (LP VTs should not have voting power)
      if (user.address === this.poolAddress) {
        throw new BadRequestException(
          'NO_VOTING_POWER',
          'Liquidity pool addresses cannot vote. VT tokens in LP are excluded from governance.'
        );
      }

      const voteWeight = snapshot.addressBalances[user.address];

      if (!voteWeight || voteWeight === '0') {
        throw new BadRequestException(
          'NO_VOTING_POWER',
          'You have no voting power in this vault. You must hold vault tokens to vote.'
        );
      }

      const totalVotingPower = Object.values(snapshot.addressBalances)
        .reduce((sum, balance) => BigInt(sum) + BigInt(balance), BigInt(0))
        .toString();
      const voteWeightPercentFromAll = (BigInt(voteWeight) * BigInt(100)) / BigInt(totalVotingPower);

      if (voteWeightPercentFromAll < vault.creation_threshold && action === 'create_proposal') {
        throw new BadRequestException(
          'BELOW_THRESHOLD',
          `Your voting power (${voteWeightPercentFromAll}) is below the minimum threshold (${vault.creation_threshold}).`
        );
      }

      if (voteWeightPercentFromAll < vault.vote_threshold && action === 'vote') {
        throw new BadRequestException(
          'BELOW_THRESHOLD',
          `Your voting power (${voteWeightPercentFromAll}) is below the minimum threshold (${vault.vote_threshold}).`
        );
      }

      return voteWeight;
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }

      this.logger.error(
        `Error getting voting power for user ${userId} in vault ${vaultId}: ${error.message}`,
        error.stack
      );
      throw new InternalServerErrorException('Error getting voting power. Please try again later.');
    }
  }
}
