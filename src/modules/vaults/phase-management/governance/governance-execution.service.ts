import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';

import { Proposal } from '@/database/proposal.entity';
import { Vote } from '@/database/vote.entity';
import { Vault } from '@/database/vault.entity';
import { Snapshot } from '@/database/snapshot.entity';
import { ProposalStatus } from '@/types/proposal.types';
import { VoteType } from '@/types/vote.types';

@Injectable()
export class GovernanceExecutionService {
  private readonly logger = new Logger(GovernanceExecutionService.name);

  constructor(
    @InjectRepository(Proposal)
    private readonly proposalRepository: Repository<Proposal>,
    @InjectRepository(Vote)
    private readonly voteRepository: Repository<Vote>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Snapshot)
    private readonly snapshotRepository: Repository<Snapshot>
  ) {}

  @Cron('*/10 * * * *')
  async processExpiredProposals(): Promise<void> {
    try {
      const expiredProposals = await this.proposalRepository.find({
        where: { status: ProposalStatus.ACTIVE, endDate: LessThan(new Date()) },
      });

      for (const proposal of expiredProposals) {
        const votes = await this.voteRepository.find({
          where: { proposalId: proposal.id },
          select: ['voteWeight', 'vote'],
        });

        const vault = await this.vaultRepository.findOne({
          where: { id: proposal.vaultId },
          select: ['execution_threshold'],
        });

        const executionThreshold = vault?.execution_threshold || 50;

        let yesVotes = BigInt(0);
        let noVotes = BigInt(0);
        
        votes.forEach(vote => {
          const weight = BigInt(vote.voteWeight);
          if (vote.vote === VoteType.YES) yesVotes += weight;
          if (vote.vote === VoteType.NO) noVotes += weight;
        });

        const totalVotes = yesVotes + noVotes;
        
        const snapshot = await this.snapshotRepository.findOne({
          where: { id: proposal.snapshotId },
        });

        const totalVotingPower = snapshot 
          ? Object.values(snapshot.addressBalances).reduce((sum, balance) => BigInt(sum) + BigInt(balance), BigInt(0))
          : BigInt(0);

        const participationPercentage = totalVotingPower > 0 
          ? Number((totalVotes * BigInt(10000)) / totalVotingPower) / 100
          : 0;

        const thresholdReached = participationPercentage >= executionThreshold;
        const yesWins = yesVotes > noVotes;
        
        const newStatus = (thresholdReached && yesWins) 
          ? ProposalStatus.EXECUTED 
          : ProposalStatus.REJECTED;

        await this.proposalRepository.update(
          { id: proposal.id },
          { 
            status: newStatus,
            executionDate: newStatus === ProposalStatus.EXECUTED ? new Date() : undefined
          }
        );

        this.logger.log(
          `Proposal ${proposal.id}: ${newStatus} (${participationPercentage.toFixed(2)}% participation, threshold ${executionThreshold}%)`
        );
      }
    } catch (error) {
      this.logger.error(`Cron error: ${error.message}`);
    }
  }

}