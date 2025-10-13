import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';

import { Proposal } from '@/database/proposal.entity';
import { ProposalStatus } from '@/types/proposal.types';
import { VoteType } from '@/types/vote.types';

@Injectable()
export class GovernanceExecutionService {
  private readonly logger = new Logger(GovernanceExecutionService.name);

  constructor(
    @InjectRepository(Proposal)
    private readonly proposalRepository: Repository<Proposal>
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async processExpiredProposals(): Promise<void> {
    try {
      const expiredProposals = await this.proposalRepository.find({
        where: { status: ProposalStatus.ACTIVE, endDate: LessThan(new Date()) },
        relations: ['vault', 'votes'],
        select: {
          id: true,
          vaultId: true,
          status: true,
          endDate: true,
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

      for (const proposal of expiredProposals) {
        const executionThreshold = proposal.vault.execution_threshold; // 50%

        let yesVotes = BigInt(0);
        let noVotes = BigInt(0);

        proposal.votes.forEach(vote => {
          const weight = BigInt(vote.voteWeight);
          if (vote.vote === VoteType.YES) yesVotes += weight;
          if (vote.vote === VoteType.NO) noVotes += weight;
        });

        const totalVotes = yesVotes + noVotes; // 100%

        const yesVotePercent = totalVotes > 0 ? (Number(yesVotes) / Number(totalVotes)) * 100 : 0;
        const isSuccessful = yesVotePercent >= executionThreshold;
        const newStatus = isSuccessful ? ProposalStatus.EXECUTED : ProposalStatus.REJECTED;

        await this.proposalRepository.update(
          { id: proposal.id },
          {
            status: newStatus,
            executionDate: newStatus === ProposalStatus.EXECUTED ? new Date() : undefined,
          }
        );

        this.logger.log(
          `Proposal ${proposal.id}: ${newStatus} (${yesVotePercent.toFixed(2)}% participation, threshold ${executionThreshold}%)`
        );
      }
    } catch (error) {
      this.logger.error(`Cron error: ${error.message}`);
    }
  }
}