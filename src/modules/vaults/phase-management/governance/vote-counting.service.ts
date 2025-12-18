import { Injectable } from '@nestjs/common';

import { Vote } from '@/database/vote.entity';
import { VoteType } from '@/types/vote.types';

export interface VoteResult {
  yesVotes: bigint;
  noVotes: bigint;
  totalVotes: bigint;
  yesVotePercent: number;
  isSuccessful: boolean;
}

@Injectable()
export class VoteCountingService {
  /**
   * Calculate vote results and determine if proposal should be executed
   * @param votes - Array of votes for the proposal
   * @param executionThreshold - Required percentage of yes votes for execution (0-100)
   * @returns Vote calculation result with success status
   */
  calculateResult(votes: Vote[], executionThreshold: number): VoteResult {
    let yesVotes = BigInt(0);
    let noVotes = BigInt(0);

    votes.forEach(vote => {
      const weight = BigInt(vote.voteWeight);
      if (vote.vote === VoteType.YES) {
        yesVotes += weight;
      } else if (vote.vote === VoteType.NO) {
        noVotes += weight;
      }
      // Abstain votes are not counted in the total
    });

    const totalVotes = yesVotes + noVotes;
    const yesVotePercent = totalVotes > 0 ? (Number(yesVotes) / Number(totalVotes)) * 100 : 0;
    const isSuccessful = yesVotePercent >= executionThreshold;

    return {
      yesVotes,
      noVotes,
      totalVotes,
      yesVotePercent,
      isSuccessful,
    };
  }
}
