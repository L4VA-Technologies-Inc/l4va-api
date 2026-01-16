import { Injectable } from '@nestjs/common';

import { VoteType } from '@/types/vote.types';

export interface VoteResult {
  yesVotes: bigint;
  noVotes: bigint;
  abstainVotes: bigint;
  totalVotes: bigint;
  totalVotesIncludingAbstain: bigint;
  yesVotePercent: number;
  noVotePercent: number;
  abstainVotePercent: number;
  participationPercent: number;
  isSuccessful: boolean;
  meetsParticipationThreshold: boolean;
}

@Injectable()
export class VoteCountingService {
  /**
   * Calculate vote results and determine if proposal should be executed
   * @param votes - Array of votes for the proposal
   * @param executionThreshold - Required percentage of yes votes for execution (0-100)
   * @param participationThreshold - Required percentage of total voting power that must participate (0-100)
   * @param totalVotingPower - Total voting power from snapshot for participation calculations
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
    participationThreshold: number = 0,
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
    const totalVotesIncludingAbstain = yesVotes + noVotes + abstainVotes;

    // Calculate percentages based on totalVotingPower if provided, otherwise based on votes cast
    const base = totalVotingPower || (totalVotes > 0 ? totalVotes : BigInt(1));
    const yesVotePercent = Number((yesVotes * BigInt(100)) / base);
    const noVotePercent = Number((noVotes * BigInt(100)) / base);
    const abstainVotePercent = Number((abstainVotes * BigInt(100)) / base);

    // Calculate participation percentage (all votes including abstain / total voting power)
    const participationPercent =
      totalVotingPower && totalVotingPower > BigInt(0)
        ? (Number(totalVotesIncludingAbstain) / Number(totalVotingPower)) * 100
        : 100; // If no total voting power provided, assume 100% participation

    // Check if minimum participation threshold is met
    const meetsParticipationThreshold = participationPercent >= participationThreshold;

    // For execution threshold, only consider yes vs no (abstain doesn't count)
    const yesVsNoPercent = totalVotes > 0 ? (Number(yesVotes) / Number(totalVotes)) * 100 : 0;
    const meetsExecutionThreshold = yesVsNoPercent >= executionThreshold;

    // Proposal is successful only if BOTH thresholds are met
    const isSuccessful = meetsParticipationThreshold && meetsExecutionThreshold;

    return {
      yesVotes,
      noVotes,
      abstainVotes,
      totalVotes,
      totalVotesIncludingAbstain,
      yesVotePercent,
      noVotePercent,
      abstainVotePercent,
      participationPercent,
      isSuccessful,
      meetsParticipationThreshold,
    };
  }
}
