import { ApiProperty } from '@nestjs/swagger';

import { TokenType } from '@/database/tokenStakingPosition.entity';

export class StakeTokenAnalyticsRes {
  @ApiProperty({ description: 'Token type', enum: TokenType, example: TokenType.L4VA })
  tokenType: TokenType;

  @ApiProperty({ description: 'Number of active staking positions for this token' })
  activePositionsCount: number;

  @ApiProperty({ description: 'Number of unique wallets with active positions for this token' })
  uniqueStakers: number;

  @ApiProperty({
    description: 'Total deposited amount in raw on-chain units (string to preserve precision)',
    example: '1000000',
  })
  totalDepositedRaw: string;

  @ApiProperty({ description: 'Total deposited amount in human-readable units', example: '100' })
  totalDepositedHuman: string;

  @ApiProperty({
    description: 'Total estimated pending rewards in raw on-chain units (what admin owes)',
    example: '8000',
  })
  totalEstimatedRewardRaw: string;

  @ApiProperty({ description: 'Total estimated pending rewards in human-readable units', example: '0.8' })
  totalEstimatedRewardHuman: string;

  @ApiProperty({ description: 'Total estimated payout (deposit + reward) in raw on-chain units', example: '1008000' })
  totalEstimatedPayoutRaw: string;

  @ApiProperty({ description: 'Total estimated payout (deposit + reward) in human-readable units', example: '100.8' })
  totalEstimatedPayoutHuman: string;

  @ApiProperty({ description: 'Average staking duration in milliseconds across all active positions' })
  averageStakingDurationMs: number;

  @ApiProperty({
    description: 'Timestamp (ms) of the oldest active stake position - longest-running staker',
    nullable: true,
  })
  oldestPositionStakedAt: number | null;

  @ApiProperty({ description: 'Timestamp (ms) of the most recently created active stake position', nullable: true })
  newestPositionStakedAt: number | null;
}

export class PendingRewardRes {
  @ApiProperty({ description: 'Token type', enum: TokenType, example: TokenType.L4VA })
  tokenType: TokenType;

  @ApiProperty({ description: 'Total pending reward in raw on-chain units', example: '8000' })
  amountRaw: string;

  @ApiProperty({ description: 'Total pending reward in human-readable units', example: '0.8' })
  amountHuman: string;
}

export class DistributedRewardRes {
  @ApiProperty({ description: 'Token type', enum: TokenType, example: TokenType.L4VA })
  tokenType: TokenType;

  @ApiProperty({ description: 'Total distributed reward all-time in raw on-chain units', example: '128000' })
  amountRaw: string;

  @ApiProperty({ description: 'Total distributed reward all-time in human-readable units', example: '12.8' })
  amountHuman: string;
}

export class DistributedRewardTimelinePointRes {
  @ApiProperty({ description: 'UTC date (YYYY-MM-DD) when rewards were distributed', example: '2026-04-28' })
  date: string;

  @ApiProperty({ description: 'Token type', enum: TokenType, example: TokenType.L4VA })
  tokenType: TokenType;

  @ApiProperty({ description: 'Distributed reward for this date/token in raw on-chain units', example: '12000' })
  amountRaw: string;

  @ApiProperty({ description: 'Distributed reward for this date/token in human-readable units', example: '12' })
  amountHuman: string;
}

export class TopStakerRes {
  @ApiProperty({ description: 'Internal user UUID' })
  userId: string;

  @ApiProperty({ description: 'Wallet address (Cardano Bech32)' })
  walletAddress: string;

  @ApiProperty({ description: 'Token type', enum: TokenType, example: TokenType.L4VA })
  tokenType: TokenType;

  @ApiProperty({ description: 'Total amount deposited in raw on-chain units', example: '500000' })
  totalDepositedRaw: string;

  @ApiProperty({ description: 'Total amount deposited in human-readable units', example: '50' })
  totalDepositedHuman: string;

  @ApiProperty({ description: 'Number of individual staking positions held' })
  positionCount: number;
}

export class StakeTransactionStatsRes {
  @ApiProperty({
    description: 'Transaction counts by type (stake, unstake, harvest, compound)',
    example: { stake: 120, unstake: 30, harvest: 15, compound: 8 },
  })
  byType: Record<string, number>;

  @ApiProperty({
    description: 'Transaction counts by status (confirmed, pending, submitted, failed, stuck, created)',
    example: { confirmed: 150, pending: 5, submitted: 2, failed: 3, stuck: 1, created: 12 },
  })
  byStatus: Record<string, number>;

  @ApiProperty({ description: 'Total number of staking-related transactions' })
  total: number;
}

export class AdminWalletBalancesRes {
  @ApiProperty({
    description: 'Whether L4VA token unit is configured in environment (policy + asset name)',
    example: true,
  })
  l4vaConfigured: boolean;

  @ApiProperty({ description: 'L4VA balance on admin wallet in raw on-chain units', example: '1500000' })
  l4vaRaw: string;

  @ApiProperty({ description: 'L4VA balance on admin wallet in human-readable units', example: '1500' })
  l4vaHuman: string;

  @ApiProperty({
    description: 'Whether VLRM token unit is configured in environment (policy + asset name)',
    example: true,
  })
  vlrmConfigured: boolean;

  @ApiProperty({ description: 'VLRM balance on admin wallet in raw on-chain units', example: '250000' })
  vlrmRaw: string;

  @ApiProperty({ description: 'VLRM balance on admin wallet in human-readable units', example: '25' })
  vlrmHuman: string;
}

export class StakeAnalyticsRes {
  @ApiProperty({ description: 'Unix timestamp (ms) when this analytics snapshot was generated' })
  generatedAt: number;

  @ApiProperty({ description: 'Currently configured staking APY in percent', example: 8 })
  apy: number;

  @ApiProperty({ description: 'Total number of currently active staking positions' })
  totalActivePositions: number;

  @ApiProperty({ description: 'Total number of closed (unstaked) positions across all history' })
  totalClosedPositions: number;

  @ApiProperty({ description: 'Number of unique wallets with at least one active staking position' })
  uniqueActiveStakers: number;

  @ApiProperty({ description: 'Number of unique wallets that have ever staked (all-time)' })
  uniqueAllTimeStakers: number;

  @ApiProperty({
    description: 'Per-token analytics breakdown for all active staking positions',
    type: [StakeTokenAnalyticsRes],
  })
  byToken: StakeTokenAnalyticsRes[];

  @ApiProperty({
    description: 'Summary of total pending rewards per token that the admin must distribute on harvest/unstake',
    type: [PendingRewardRes],
  })
  totalPendingRewards: PendingRewardRes[];

  @ApiProperty({
    description: 'All-time distributed rewards per token based on closed positions',
    type: [DistributedRewardRes],
  })
  totalDistributedRewardsAllTime: DistributedRewardRes[];

  @ApiProperty({
    description: 'Daily distributed rewards timeline (UTC) split by token type for charting',
    type: [DistributedRewardTimelinePointRes],
  })
  distributedRewardsTimeline: DistributedRewardTimelinePointRes[];

  @ApiProperty({ description: 'Staking-related transaction statistics', type: StakeTransactionStatsRes })
  transactions: StakeTransactionStatsRes;

  @ApiProperty({
    description:
      'Top 20 staker entries ranked by deposited amount for each user/token pair (not aggregated across tokens)',
    type: [TopStakerRes],
  })
  topStakers: TopStakerRes[];

  @ApiProperty({
    description: 'Current L4VA and VLRM balances on the admin wallet',
    type: AdminWalletBalancesRes,
  })
  adminWalletBalances: AdminWalletBalancesRes;
}
