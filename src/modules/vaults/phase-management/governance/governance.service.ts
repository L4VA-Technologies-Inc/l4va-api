import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import NodeCache from 'node-cache';
import { In, IsNull, Not, Repository } from 'typeorm';

import { CreateProposalReq } from './dto/create-proposal.req';
import { AssetBuySellDto } from './dto/get-assets.dto';
import { GetProposalsResItem } from './dto/get-proposal.dto';
import { VoteReq } from './dto/vote.req';

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

const TWO_HOURS = 2 * 60 * 60 * 1000;

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
    private readonly eventEmitter: EventEmitter2
  ) {
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_TESTNET_API_KEY'),
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

  // @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async createDailySnapshots(): Promise<void> {
    this.logger.log('Starting daily snapshot creation');

    try {
      const lockedVaults = await this.vaultRepository.find({
        where: {
          vault_status: VaultStatus.locked,
          asset_vault_name: Not(IsNull()),
          policy_id: Not(IsNull()),
        },
        select: ['id', 'asset_vault_name', 'policy_id'],
      });

      if (lockedVaults.length === 0) {
        this.logger.log('No eligible vaults found for snapshot creation');
        return;
      }

      this.logger.log(`Found ${lockedVaults.length} locked vaults for snapshots`);

      const results = await Promise.allSettled(
        lockedVaults.map(async (vault, index) => {
          if (index > 0) {
            await new Promise(resolve => setTimeout(resolve, 5000)); //  Add delay between requests to avoid overwhelming BlockFrost
          }
          const snapshot = await this.createAutomaticSnapshot(vault.id, `${vault.policy_id}${vault.asset_vault_name}`);
          return snapshot;
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
  private async createAutomaticSnapshot(vaultId: string, assetId: string): Promise<Snapshot> {
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
            // Add addresses and balances to the mapping
            for (const item of response) {
              addressBalances[item.address] = item.quantity;
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
  ): Promise<{
    success: boolean;
    message: string;
    proposal: {
      id: string;
      vaultId: string;
      title: string;
      description: string;
      creatorId: string;
      status: ProposalStatus;
      createdAt: Date;
      endDate: Date;
    };
  }> {
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

    let latestSnapshot = await this.snapshotRepository.findOne({
      where: { vaultId },
      order: { createdAt: 'DESC' },
    });

    if (!latestSnapshot || new Date().getTime() - new Date(latestSnapshot.createdAt).getTime() > TWO_HOURS) {
      latestSnapshot = await this.createAutomaticSnapshot(vaultId, `${vault.policy_id}${vault.asset_vault_name}`);
    }

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

    // Set type-specific fields based on proposal type
    switch (createProposalReq.type) {
      case ProposalType.STAKING:
        proposal.fungibleTokens = createProposalReq.fts || [];
        proposal.nonFungibleTokens = createProposalReq.nfts || [];
        break;

      case ProposalType.DISTRIBUTION:
        proposal.distributionAssets = createProposalReq.distributionAssets || [];
        break;

      case ProposalType.TERMINATION:
        if (createProposalReq.metadata) {
          proposal.terminationReason = createProposalReq.metadata.reason;
          proposal.terminationDate = createProposalReq.metadata.terminationDate
            ? new Date(createProposalReq.metadata.terminationDate)
            : undefined;
        }
        break;

      case ProposalType.BURNING:
        if (createProposalReq.metadata) {
          proposal.burnAssets = createProposalReq.metadata.burnAssets || [];
        }
        break;

      case ProposalType.BUY_SELL:
        if (createProposalReq.metadata) {
          proposal.buyingSellingOptions = createProposalReq.metadata.buyingSellingOptions || [];
          proposal.abstain = createProposalReq.metadata.abstain || false;

          for (const option of proposal.buyingSellingOptions) {
            const asset = await this.assetRepository.findOne({
              where: { id: option.assetId },
            });

            if (!asset) {
              throw new BadRequestException(`Asset with ID ${option.assetId} not found`);
            }
          }
        }
        break;
    }

    await this.proposalRepository.save(proposal);

    this.eventEmitter.emit('proposal.created', {
      proposalId: proposal.id,
      startDate: proposal.startDate,
      endDate: proposal.endDate,
      status: proposal.status,
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
    const processedProposals = await Promise.all(
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

        if (proposal.status !== ProposalStatus.UPCOMING) {
          try {
            const { totals } = await this.getVotes(proposal.id);

            let yesPercentage = 0;
            let noPercentage = 0;
            let abstainPercentage = 0;

            if (BigInt(totals.totalVotingPower) > 0) {
              yesPercentage = Number((BigInt(totals.yes) * BigInt(100)) / BigInt(totals.totalVotingPower));
              noPercentage = Number((BigInt(totals.no) * BigInt(100)) / BigInt(totals.totalVotingPower));

              if (proposal.abstain) {
                abstainPercentage = Number((BigInt(totals.abstain) * BigInt(100)) / BigInt(totals.totalVotingPower));
              }
            }

            return {
              ...baseProposal,
              votes: {
                yes: yesPercentage,
                no: noPercentage,
                abstain: abstainPercentage,
              },
            };
          } catch (error) {
            this.logger.error(`Error fetching votes for proposal ${proposal.id}: ${error.message}`, error.stack);
            // Return proposal without votes on error
            return baseProposal;
          }
        }
        // For other statuses, return base proposal
        else {
          return baseProposal;
        }
      })
    );

    return processedProposals;
  }

  async getProposal(
    proposalId: string,
    userId: string
  ): Promise<{
    proposal: Proposal;
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
      votedPercentage: number;
    };
    canVote: boolean;
    selectedVote: VoteType | null;
  }> {
    const proposal = await this.proposalRepository.findOne({
      where: { id: proposalId },
    });

    if (!proposal) {
      throw new NotFoundException('Proposal not found');
    }

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

    return {
      proposal,
      votes,
      totals,
      canVote,
      selectedVote,
    };
  }

  async vote(
    proposalId: string,
    voteReq: VoteReq,
    userId: string
  ): Promise<{
    success: boolean;
    message: string;
    vote: {
      id: string;
      proposalId: string;
      voterId: string;
      voterAddress: string;
      voteWeight: string;
      vote: VoteType;
      timestamp: Date;
    };
  }> {
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

    const totalVotingPower = Object.values(snapshot.addressBalances)
      .reduce((sum, balance) => BigInt(sum) + BigInt(balance), BigInt(0))
      .toString();

    // Calculate vote totals
    const totals = {
      yes: '0',
      no: '0',
      abstain: '0',
      totalVotingPower, // Include this in the returned totals
      votedPercentage: 0,
    };

    votes.forEach(vote => {
      if (vote.vote === VoteType.YES) {
        totals.yes = (BigInt(totals.yes) + BigInt(vote.voteWeight)).toString();
      } else if (vote.vote === VoteType.NO) {
        totals.no = (BigInt(totals.no) + BigInt(vote.voteWeight)).toString();
      } else if (vote.vote === VoteType.ABSTAIN) {
        totals.abstain = (BigInt(totals.abstain) + BigInt(vote.voteWeight)).toString();
      }
    });

    // Calculate the percentage of total voting power that has voted
    const votedVotingPower = BigInt(totals.yes) + BigInt(totals.no) + BigInt(totals.abstain);
    if (BigInt(totalVotingPower) > 0) {
      totals.votedPercentage = Number((votedVotingPower * BigInt(100)) / BigInt(totalVotingPower));
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
      const assets = await this.assetRepository.find({
        where: { vault: { id: vaultId } },
      });
      return assets;
    } catch (error) {
      this.logger.error(`Error getting assets to stake for vault ${vaultId}: ${error.message}`, error.stack);
      throw new InternalServerErrorException('Error getting assets to stake');
    }
  }

  /**
   *  Distribute: Should not allow to distribute NFTs.
   * WH
   */
  async getAssetsToDistribute(vaultId: string): Promise<Asset[]> {
    try {
      const assets = await this.assetRepository.find({
        where: { vault: { id: vaultId }, type: AssetType.FT, status: AssetStatus.LOCKED },
      });
      return assets;
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
      const assets = await this.assetRepository.find({
        where: [
          { vault: { id: vaultId }, type: AssetType.NFT, status: AssetStatus.LOCKED },
          { vault: { id: vaultId }, type: AssetType.FT, status: AssetStatus.LOCKED },
        ],
        select: ['id', 'policy_id', 'quantity', 'dex_price', 'floor_price', 'metadata', 'type'],
      });

      return plainToInstance(AssetBuySellDto, assets, {
        excludeExtraneousValues: true,
      });
    } catch (error) {
      this.logger.error(`Error getting assets for buy-sell proposals for vault ${vaultId}: ${error.message}`);
      throw new InternalServerErrorException('Error getting assets for buying/selling');
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
    } catch (error) {
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
