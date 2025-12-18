import { Injectable } from '@nestjs/common';

import { VoteType } from '@/types/vote.types';

export interface VoteResult {
  yesVotes: bigint;
  noVotes: bigint;
  abstainVotes: bigint;
  totalVotes: bigint;
  yesVotePercent: number;
  noVotePercent: number;
  abstainVotePercent: number;
  isSuccessful: boolean;
}

@Injectable()
export class VoteCountingService {
  /**
   * Calculate vote results and determine if proposal should be executed
   * @param votes - Array of votes for the proposal
   * @param executionThreshold - Required percentage of yes votes for execution (0-100)
   * @param totalVotingPower - Optional total voting power for percentage calculations relative to total power
   * @returns Vote calculation result with success status
   */
  calculateResult(
    votes: {
      id: string;
      voterAddress: string;
      voteWeight: string;
      vote: VoteType;
      timestamp: Date;
    }[],
    executionThreshold: number,
    totalVotingPower?: bigint
  ): VoteResult {
    let yesVotes = BigInt(0);
    let noVotes = BigInt(0);
    let abstainVotes = BigInt(0);

    votes.forEach(vote => {
      const weight = BigInt(vote.voteWeight);
      if (vote.vote === VoteType.YES) {
        yesVotes += weight;
      } else if (vote.vote === VoteType.NO) {
        noVotes += weight;
      } else if (vote.vote === VoteType.ABSTAIN) {
        abstainVotes += weight;
      }
    });

    const totalVotes = yesVotes + noVotes;

    // Calculate percentages based on totalVotingPower if provided, otherwise based on votes cast
    const base = totalVotingPower || (totalVotes > 0 ? totalVotes : BigInt(1));
    const yesVotePercent = Number((yesVotes * BigInt(100)) / base);
    const noVotePercent = Number((noVotes * BigInt(100)) / base);
    const abstainVotePercent = Number((abstainVotes * BigInt(100)) / base);

    // For execution threshold, only consider yes vs no (abstain doesn't count)
    const yesVsNoPercent = totalVotes > 0 ? (Number(yesVotes) / Number(totalVotes)) * 100 : 0;
    const isSuccessful = yesVsNoPercent >= executionThreshold;

    return {
      yesVotes,
      noVotes,
      abstainVotes,
      totalVotes,
      yesVotePercent,
      noVotePercent,
      abstainVotePercent,
      isSuccessful,
    };
  }
}
