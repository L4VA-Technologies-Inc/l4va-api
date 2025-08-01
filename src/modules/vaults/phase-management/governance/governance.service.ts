import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CreateProposalReq, CreateSnapshotDto } from './dto/create-proposal.req';
import { VoteReq } from './dto/vote.req';

import { Proposal } from '@/database/proposal.entity';
import { Snapshot } from '@/database/snapshot.entity';
import { Vault } from '@/database/vault.entity';
import { Vote } from '@/database/vote.entity';
import { ProposalStatus } from '@/types/proposal.types';
import { VaultStatus } from '@/types/vault.types';
import { VoteType } from '@/types/vote.types';

@Injectable()
export class GovernanceService {
  private blockfrost: BlockFrostAPI;
  private readonly logger = new Logger(GovernanceService.name);

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Snapshot)
    private readonly snapshotRepository: Repository<Snapshot>,
    @InjectRepository(Proposal)
    private readonly proposalRepository: Repository<Proposal>,
    @InjectRepository(Vote)
    private readonly voteRepository: Repository<Vote>,
    private readonly configService: ConfigService
  ) {
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_TESTNET_API_KEY'),
    });
  }

  async createSnapshot(
    vaultId: string,
    createSnapshotDto: CreateSnapshotDto
  ): Promise<{
    success: boolean;
    message: string;
    snapshot: {
      id: string;
      vaultId: string;
      assetId: string;
      addressCount: number;
      createdAt: Date;
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

    try {
      // Fetch all addresses holding the asset using BlockFrost
      const addressBalances: Record<string, string> = {};
      let page = 1;
      let hasMorePages = true;

      while (hasMorePages) {
        const response = await this.blockfrost.assetsAddresses(createSnapshotDto.assetId, { page, order: 'desc' });

        if (response.length === 0) {
          hasMorePages = false;
        } else {
          // Add addresses and balances to the mapping
          for (const item of response) {
            addressBalances[item.address] = item.quantity;
          }
          page++;
        }
      }

      // Create and save the snapshot
      const snapshot = this.snapshotRepository.create({
        vaultId,
        assetId: createSnapshotDto.assetId,
        addressBalances,
      });

      await this.snapshotRepository.save(snapshot);

      return {
        success: true,
        message: 'Snapshot created successfully',
        snapshot: {
          id: snapshot.id,
          vaultId,
          assetId: createSnapshotDto.assetId,
          addressCount: Object.keys(addressBalances).length,
          createdAt: snapshot.createdAt,
        },
      };
    } catch (error) {
      this.logger.error(`Failed to create snapshot: ${error.message}`, error.stack);
      throw new BadRequestException(`Failed to create snapshot: ${error.message}`);
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

  async createProposal(vaultId: string, createProposalReq: CreateProposalReq, userId: string) {
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
    });

    if (!vault) {
      throw new NotFoundException('Vault not found');
    }

    if (vault.vault_status !== VaultStatus.locked) {
      throw new BadRequestException('Governance is only available for locked vaults');
    }

    // Get the latest snapshot for the vault
    const latestSnapshot = await this.snapshotRepository.findOne({
      where: { vaultId },
      order: { createdAt: 'DESC' },
    });

    if (!latestSnapshot) {
      throw new BadRequestException('No snapshot available for voting power determination');
    }

    // Create and save the proposal
    const proposal = this.proposalRepository.create({
      vaultId,
      title: createProposalReq.title,
      description: createProposalReq.description,
      creatorId: userId,
      snapshotId: latestSnapshot.id,
      status: ProposalStatus.ACTIVE,
      endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days from now
    });

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

  async getProposals(vaultId: string): Promise<{
    proposals: {
      id: string;
      vaultId: string;
      title: string;
      description: string;
      creatorId: string;
      status: 'active' | 'passed' | 'rejected' | 'executed';
      createdAt: Date;
      endDate: Date;
    }[];
  }> {
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

    return {
      proposals: proposals.map(proposal => ({
        id: proposal.id,
        vaultId: proposal.vaultId,
        title: proposal.title,
        description: proposal.description,
        creatorId: proposal.creatorId,
        status: proposal.status,
        createdAt: proposal.createdAt,
        endDate: proposal.endDate,
      })),
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

    if (proposal.status !== 'active') {
      throw new BadRequestException('Voting is only allowed on active proposals');
    }

    if (new Date() > proposal.endDate) {
      throw new BadRequestException('Voting period has ended');
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
      if (vote.vote === 'yes') {
        totals.yes = (BigInt(totals.yes) + BigInt(vote.voteWeight)).toString();
      } else if (vote.vote === 'no') {
        totals.no = (BigInt(totals.no) + BigInt(vote.voteWeight)).toString();
      } else if (vote.vote === 'abstain') {
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

  async getProposal(proposalId: string) {
    const proposal = await this.proposalRepository.findOne({
      where: { id: proposalId },
    });

    if (!proposal) {
      throw new NotFoundException('Proposal not found');
    }

    // Get votes for this proposal
    const { votes, totals } = await this.getVotes(proposalId);

    return {
      proposal: {
        id: proposal.id,
        vaultId: proposal.vaultId,
        title: proposal.title,
        description: proposal.description,
        creatorId: proposal.creatorId,
        status: proposal.status,
        createdAt: proposal.createdAt,
        endDate: proposal.endDate,
      },
      votes,
      totals,
    };
  }
}
