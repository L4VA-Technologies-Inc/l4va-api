import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateProposalReq } from './dto/create-proposal.req';
import { VoteReq } from './dto/vote.req';
import {Vault} from "../../database/vault.entity";
import {VaultStatus} from "../../types/vault.types";

@Injectable()
export class GovernanceService {
  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
  ) {}

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

    // TODO: Check if user has sufficient voting power (based on contribution/investment)

    // TODO: Implement blockchain integration for proposal creation
    // For now, return mock response
    return {
      success: true,
      message: 'Proposal created successfully',
      proposal: {
        id: 'mock-proposal-id',
        vaultId,
        creatorId: userId,
        ...createProposalReq,
        status: 'active',
        createdAt: new Date().toISOString(),
      },
    };
  }

  async getProposals(vaultId: string) {
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
    });

    if (!vault) {
      throw new NotFoundException('Vault not found');
    }

    // TODO: Implement proposal retrieval from blockchain/database
    // For now, return mock data
    return {
      proposals: [],
    };
  }

  async vote(proposalId: string, voteReq: VoteReq, userId: string) {
    // TODO: Implement blockchain integration for voting
    // For now, return mock response
    return {
      success: true,
      message: 'Vote recorded successfully',
      vote: {
        proposalId,
        voterId: userId,
        ...voteReq,
        timestamp: new Date().toISOString(),
      },
    };
  }

  async getProposal(proposalId: string) {
    // TODO: Implement proposal retrieval from blockchain/database
    // For now, throw not found
    throw new NotFoundException('Proposal not found');
  }
}
