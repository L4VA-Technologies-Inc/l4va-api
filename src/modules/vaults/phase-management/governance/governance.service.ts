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
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

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
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async createDailySnapshots(): Promise<void> {
    this.logger.log('Starting daily snapshot creation');

    try {
      const lockedVaults = await this.vaultRepository.find({
        where: {
          vault_status: VaultStatus.locked,
          asset_vault_name: Not(IsNull()),
          policy_id: Not(IsNull()),
        },
      });

      this.logger.log(`Found ${lockedVaults.length} locked vaults for snapshots`);

      for (const vault of lockedVaults) {
        try {
          if (!vault.asset_vault_name || !vault.policy_id) {
            this.logger.warn(`Vault ${vault.id} missing asset info, skipping snapshot`);
            continue;
          }

          await this.createAutomaticSnapshot(vault.id, `${vault.policy_id}${vault.asset_vault_name}`);
          await new Promise(resolve => setTimeout(resolve, 5000)); // Add some delay between requests to not overwhelm the BlockFrost API
        } catch (error) {
          this.logger.error(`Error creating snapshot for vault ${vault.id}: ${error.message}`, error.stack);
          // Continue with the next vault even if one fails
        }
      }

      this.logger.log('Daily snapshot creation completed');
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

  async getSnapshots(vaultId: string): Promise<{
    snapshots: {
      id: string;
      vaultId: string;
      assetId: string;
      addressCount: number;
      createdAt: Date;
    }[];
  }> {
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
    });

    if (!vault) {
      throw new NotFoundException('Vault not found');
    }

    const snapshots = await this.snapshotRepository.find({
      where: { vaultId },
      order: { createdAt: 'DESC' },
    });

    return {
      snapshots: snapshots.map(snapshot => ({
        id: snapshot.id,
        vaultId: snapshot.vaultId,
        assetId: snapshot.assetId,
        addressCount: Object.keys(snapshot.addressBalances).length,
        createdAt: snapshot.createdAt,
      })),
    };
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

    // Determine start date - use the provided one or now if not provided
    let startDate: Date;
    if (createProposalReq.startDate) {
      startDate = new Date(createProposalReq.startDate);
    } else if (createProposalReq.proposalStart) {
      startDate = new Date(createProposalReq.proposalStart);
    } else {
      startDate = new Date();
    }

    // Create the proposal with the appropriate fields based on type
    const proposal = this.proposalRepository.create({
      vaultId,
      title: createProposalReq.title,
      description: createProposalReq.description,
      creatorId: userId,
      proposalType: createProposalReq.type,
      startDate: startDate.toISOString(),
      snapshotId: latestSnapshot.id,
      status: ProposalStatus.ACTIVE,
      endDate: new Date(Date.now() + SEVEN_DAYS), // SEVEN
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
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
    });

    if (!vault) {
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
          vaultId: proposal.vaultId,
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

            // Calculate total votes
            const totalVotingPower = BigInt(totals.yes) + BigInt(totals.no) + BigInt(totals.abstain);

            // Calculate percentages
            let yesPercentage = 0;
            let noPercentage = 0;
            let abstainPercentage = 0;

            if (totalVotingPower > 0) {
              yesPercentage = Number((BigInt(totals.yes) * BigInt(100)) / totalVotingPower);
              noPercentage = Number((BigInt(totals.no) * BigInt(100)) / totalVotingPower);
              if (proposal.abstain) {
                abstainPercentage = Number((BigInt(totals.abstain) * BigInt(100)) / totalVotingPower);
              }
              // Ensure percentages sum to 100% due to integer division
              const sumPercentages = yesPercentage + noPercentage + abstainPercentage;
              if (sumPercentages < 100) {
                // Find the largest percentage and add the difference to it
                if (yesPercentage >= noPercentage && yesPercentage >= abstainPercentage) {
                  yesPercentage += 100 - sumPercentages;
                } else if (noPercentage >= yesPercentage && noPercentage >= abstainPercentage) {
                  noPercentage += 100 - sumPercentages;
                } else {
                  abstainPercentage += 100 - sumPercentages;
                }
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

    // Get the snapshot associated with the proposal
    const snapshot = await this.snapshotRepository.findOne({
      where: { id: proposal.snapshotId },
    });

    if (!snapshot) {
      throw new NotFoundException('Snapshot not found');
    }

    // Check if the user's address has voting power in the snapshot
    const voterAddress = voteReq.voterAddress;
    const voteWeight = snapshot.addressBalances[voterAddress];

    if (!voteWeight || voteWeight === '0') {
      throw new BadRequestException('Address has no voting power in the snapshot');
    }

    // Check if user has already voted
    const existingVote = await this.voteRepository.findOne({
      where: {
        proposalId,
        voterAddress,
      },
    });

    if (existingVote) {
      throw new BadRequestException('Address has already voted on this proposal');
    }

    // Create and save the vote
    const vote = this.voteRepository.create({
      proposalId,
      snapshotId: snapshot.id,
      voterId: userId,
      voterAddress,
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
        voterAddress,
        voteWeight,
        vote: voteReq.vote,
        timestamp: vote.timestamp,
      },
    };
  }

  async getVotes(proposalId: string): Promise<{
    votes: {
      id: string;
      proposalId: string;
      voterId: string;
      voterAddress: string;
      voteWeight: string;
      vote: VoteType;
      timestamp: Date;
    }[];
    totals: {
      yes: string;
      no: string;
      abstain: string;
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
    });

    // Calculate vote totals
    const totals = {
      yes: '0',
      no: '0',
      abstain: '0',
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

    return {
      votes: votes.map(vote => ({
        id: vote.id,
        proposalId: vote.proposalId,
        voterId: vote.voterId,
        voterAddress: vote.voterAddress,
        voteWeight: vote.voteWeight,
        vote: vote.vote,
        timestamp: vote.timestamp,
      })),
      totals,
    };
  }

  async getProposal(proposalId: string): Promise<{
    proposal: Proposal;
    votes: {
      id: string;
      proposalId: string;
      voterId: string;
      voterAddress: string;
      voteWeight: string;
      vote: VoteType;
      timestamp: Date;
    }[];
    totals: {
      yes: string;
      no: string;
      abstain: string;
    };
  }> {
    const proposal = await this.proposalRepository.findOne({
      where: { id: proposalId },
    });

    if (!proposal) {
      throw new NotFoundException('Proposal not found');
    }

    const { votes, totals } = await this.getVotes(proposalId);

    return {
      proposal,
      votes,
      totals,
    };
  }

  async getVotingPower(vaultId: string, userId: string, action?: 'vote' | 'create_proposal'): Promise<string> {
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

      if (+voteWeight < vault.creation_threshold && action === 'vote') {
        throw new BadRequestException(
          'BELOW_THRESHOLD',
          `Your voting power (${voteWeight}) is below the minimum threshold (${vault.creation_threshold}).`
        );
      }

      if (+voteWeight < vault.vote_threshold && action === 'create_proposal') {
        throw new BadRequestException(
          'BELOW_THRESHOLD',
          `Your voting power (${voteWeight}) is below the minimum threshold (${vault.vote_threshold}).`
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

  async getAssetsToDistribute(vaultId: string): Promise<Asset[]> {
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

  async getAssetsToTerminate(vaultId: string): Promise<Asset[]> {
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
}
