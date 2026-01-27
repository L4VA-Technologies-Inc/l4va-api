import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';

import { DistributionStatus } from '../distribution.service';

import { DistributionBatchStatus } from './distribution.dto';

import { AssetType } from '@/types/asset.types';
import { ProposalStatus, ProposalType } from '@/types/proposal.types';
import { VoteType } from '@/types/vote.types';

export class ProposalDetailDto {
  @Expose()
  @ApiProperty({ description: 'Proposal ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  id: string;

  @Expose()
  @ApiProperty({ description: 'Proposal title', example: 'Acquire SpaceBud Collection' })
  title: string;

  @Expose()
  @ApiProperty({ description: 'Proposal description', example: 'Proposal to acquire 10 SpaceBuds...' })
  description: string;

  @Expose()
  @ApiProperty({ description: 'Proposal status', enum: ProposalStatus, example: ProposalStatus.ACTIVE })
  status: ProposalStatus;

  @Expose()
  @ApiProperty({ description: 'Proposal type', enum: ProposalType, example: ProposalType.STAKING })
  proposalType: ProposalType;

  @Expose()
  @ApiPropertyOptional({ description: 'IPFS hash', example: 'QmXyZ...' })
  ipfsHash?: string;

  @Expose()
  @ApiPropertyOptional({ description: 'External link', example: 'https://example.com' })
  externalLink?: string;

  @Expose()
  @ApiProperty({ description: 'Start date', example: '2023-08-01T10:00:00Z' })
  startDate: Date;

  @Expose()
  @ApiProperty({ description: 'End date', example: '2023-08-15T10:00:00Z' })
  endDate: Date;

  @Expose()
  @ApiPropertyOptional({ description: 'Execution date', example: '2023-08-16T10:00:00Z' })
  executionDate?: Date;

  @Expose()
  @ApiPropertyOptional({ description: 'Termination date', example: '2023-12-31T10:00:00Z' })
  terminationDate?: Date;

  @Expose()
  @ApiProperty({ description: 'Allow abstain votes', example: true })
  abstain: boolean;

  @Expose()
  @ApiProperty({ description: 'Snapshot ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  snapshotId: string;

  @Expose()
  @ApiProperty({ description: 'Vault ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  vaultId: string;

  @Expose()
  @ApiProperty({ description: 'Creator ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  creatorId: string;

  @Expose()
  @ApiProperty({ description: 'Created at', example: '2023-08-01T09:00:00Z' })
  createdAt: Date;

  @Expose()
  @ApiProperty({ description: 'Metadata associated with the proposal' })
  metadata: any;

  @Expose()
  @ApiPropertyOptional({ description: 'Execution error details if proposal failed' })
  executionError?: {
    message: string;
    timestamp: string;
    errorCode?: string;
  };

  @Expose()
  @ApiPropertyOptional({ description: 'Vault information including termination configuration', type: Object })
  vault?: {
    id: string;
    name: string;
    vault_token_ticker?: string;
    vault_status?: string;
    termination_type?: string;
    terminationMetadata?: any; // Includes status, txHashes, etc.
  };
}

export class ProposalVoteDto {
  @Expose()
  @ApiProperty({ description: 'Vote ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  id: string;

  @Expose()
  @ApiProperty({ description: 'Voter address', example: 'addr1q934ccfkwy292....' })
  voterAddress: string;

  @Expose()
  @ApiProperty({ description: 'Vote weight', example: '1000000' })
  voteWeight: string;

  @Expose()
  @ApiProperty({ description: 'Vote type', enum: VoteType, example: VoteType.YES })
  vote: VoteType;

  @Expose()
  @ApiProperty({ description: 'Vote timestamp', example: '2023-08-15T10:30:00Z' })
  timestamp: Date;
}

export class VoteTotalsDto {
  @Expose()
  @ApiProperty({ description: 'Total yes votes', example: '5000000' })
  yes: string;

  @Expose()
  @ApiProperty({ description: 'Total no votes', example: '2000000' })
  no: string;

  @Expose()
  @ApiProperty({ description: 'Total abstain votes', example: '1000000' })
  abstain: string;

  @Expose()
  @ApiProperty({ description: 'Percentage of votes cast', example: 65.5 })
  votedPercentage: number;
}

export class ProposerDto {
  @Expose()
  @ApiProperty({ description: 'Proposer user ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  id: string;

  @Expose()
  @ApiProperty({ description: 'Proposer wallet address', example: 'addr1q934ccfkwy292....' })
  address: string;
}

export class ProposalAssetDto {
  @Expose()
  @ApiProperty({ description: 'Asset ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  id: string;

  @Expose()
  @ApiProperty({ description: 'Asset name', example: 'SpaceBud #1234' })
  name: string;

  @Expose()
  @ApiPropertyOptional({ description: 'Asset image URL', example: 'https://ipfs.io/ipfs/Qm...' })
  imageUrl?: string;

  @Expose()
  @ApiPropertyOptional({
    description: 'Policy ID',
    example: 'd5e6bf0500378d4f0da4e8dde6becec7621cd8cbf5cbb9b87013d4cc',
  })
  policyId?: string;

  @Expose()
  @ApiPropertyOptional({ description: 'Asset ID on chain', example: '537061636542756431323334' })
  assetId?: string;

  @Expose()
  @ApiPropertyOptional({ description: 'Asset type', enum: AssetType })
  type?: AssetType;

  @Expose()
  @ApiPropertyOptional({ description: 'Asset quantity', example: 1 })
  quantity?: number;
}

export class BurnAssetDto extends ProposalAssetDto {}

export class StakingTokenDto extends ProposalAssetDto {
  @Expose()
  @ApiPropertyOptional({ description: 'Market for staking proposal', example: 'm1' })
  market?: string;
}

export class MarketplaceActionDetailDto {
  @Expose()
  @ApiProperty({ description: 'Asset ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  assetId: string;

  @Expose()
  @ApiProperty({ description: 'Action type: BUY, SELL, UNLIST, or UPDATE_LISTING', example: 'SELL' })
  exec: string;

  @Expose()
  @ApiPropertyOptional({ description: 'Asset name', example: 'SpaceBud #1234' })
  assetName?: string;

  @Expose()
  @ApiPropertyOptional({ description: 'Asset image URL', example: 'https://ipfs.io/ipfs/Qm...' })
  assetImg?: string;

  @Expose()
  @ApiPropertyOptional({ description: 'Asset price (floor or dex)', example: 100 })
  assetPrice?: number;

  @Expose()
  @ApiPropertyOptional({ description: 'Current listing price', example: 120 })
  listingPrice?: number;

  @Expose()
  @ApiPropertyOptional({ description: 'Quantity to buy/sell', example: '1' })
  quantity?: string;

  @Expose()
  @ApiPropertyOptional({ description: 'Sell type', example: 'MARKET' })
  sellType?: string;

  @Expose()
  @ApiPropertyOptional({ description: 'Duration in milliseconds', example: 86400000 })
  duration?: number;

  @Expose()
  @ApiPropertyOptional({ description: 'Method', example: 'GTC' })
  method?: string;

  @Expose()
  @ApiPropertyOptional({ description: 'Price in ADA', example: '100.5' })
  price?: string;

  @Expose()
  @ApiPropertyOptional({ description: 'New price for update listing', example: '110.5' })
  newPrice?: string;

  @Expose()
  @ApiPropertyOptional({
    description: 'WayUp marketplace URL for this asset',
    example:
      'https://www.wayup.io/collection/d5e6bf0500378d4f0da4e8dde6becec7621cd8cbf5cbb9b87013d4cc/asset/537061636542756431323334?tab=activity',
  })
  wayupUrl?: string;

  @Expose()
  @ApiPropertyOptional({
    description: 'Current status of the asset (e.g., LOCKED, LISTED, SOLD)',
    example: 'SOLD',
  })
  assetStatus?: string;
}

/**
 * Distribution proposal info (calculated from snapshot)
 */
export class DistributionInfoDto {
  @Expose()
  @ApiProperty({ description: 'Total ADA amount to distribute', example: 100 })
  totalAdaAmount: number;

  @Expose()
  @ApiProperty({ description: 'Total VT holders in snapshot', example: 50 })
  totalHolders: number;

  @Expose()
  @ApiProperty({ description: 'Holders who will receive distribution (share >= 2 ADA)', example: 45 })
  eligibleHolders: number;

  @Expose()
  @ApiProperty({ description: 'Holders who will not receive distribution (share < 2 ADA)', example: 5 })
  skippedHolders: number;

  @Expose()
  @ApiProperty({ description: 'Average ADA per eligible holder', example: 2.22 })
  avgAdaPerHolder: number;

  @Expose()
  @ApiProperty({ description: 'Minimum ADA per recipient (Cardano requirement)', example: 2 })
  minAdaPerRecipient: number;
}

/**
 * Distribution batch details for proposal response
 */
export class DistributionBatchDetailDto {
  @Expose()
  @ApiProperty({ description: 'Unique batch identifier' })
  batchId: string;

  @Expose()
  @ApiProperty({ description: 'Batch number in sequence', example: 1 })
  batchNumber: number;

  @Expose()
  @ApiProperty({ description: 'Total number of batches', example: 5 })
  totalBatches: number;

  @Expose()
  @ApiProperty({ description: 'Number of recipients in this batch', example: 40 })
  recipientCount: number;

  @Expose()
  @ApiProperty({ description: 'Total lovelace amount in this batch' })
  lovelaceAmount: string;

  @Expose()
  @ApiProperty({
    description: 'Batch processing status',
    enum: DistributionBatchStatus,
  })
  status: DistributionBatchStatus;

  @Expose()
  @ApiPropertyOptional({ description: 'Transaction hash if submitted' })
  txHash?: string;

  @Expose()
  @ApiProperty({ description: 'Number of retry attempts', example: 0 })
  retryCount: number;

  @Expose()
  @ApiPropertyOptional({ description: 'Error message if failed' })
  error?: string;
}

/**
 * Distribution execution status for proposal response
 */
export class DistributionStatusDto {
  @Expose()
  @ApiProperty({
    description: 'Overall distribution status',
    enum: ['pending', 'in_progress', 'completed', 'partially_failed', 'failed'],
  })
  status: DistributionStatus;

  @Expose()
  @ApiProperty({ description: 'Total number of batches', example: 5 })
  totalBatches: number;

  @Expose()
  @ApiProperty({ description: 'Number of completed batches', example: 3 })
  completedBatches: number;

  @Expose()
  @ApiProperty({ description: 'Number of failed batches', example: 1 })
  failedBatches: number;

  @Expose()
  @ApiProperty({ description: 'Number of batches pending retry', example: 1 })
  pendingRetry: number;

  @Expose()
  @ApiProperty({ description: 'Total lovelace actually distributed so far' })
  totalDistributed: string;

  @Expose()
  @ApiProperty({ description: 'Total recipients receiving distribution' })
  totalRecipients: number;

  @Expose()
  @ApiProperty({ description: 'Individual batch details', type: [DistributionBatchDetailDto] })
  @Type(() => DistributionBatchDetailDto)
  batches: DistributionBatchDetailDto[];
}

export class GetProposalDetailRes {
  @Expose()
  @ApiProperty({ description: 'Proposal details', type: ProposalDetailDto })
  @Type(() => ProposalDetailDto)
  proposal: ProposalDetailDto;

  @Expose()
  @ApiProperty({ description: 'List of votes', type: [ProposalVoteDto] })
  @Type(() => ProposalVoteDto)
  votes: ProposalVoteDto[];

  @Expose()
  @ApiProperty({ description: 'Vote totals', type: VoteTotalsDto })
  @Type(() => VoteTotalsDto)
  totals: VoteTotalsDto;

  @Expose()
  @ApiProperty({ description: 'Whether the user can vote', example: true })
  canVote: boolean;

  @Expose()
  @ApiProperty({ description: 'User selected vote if any', enum: VoteType, required: false, example: VoteType.YES })
  selectedVote: VoteType | null;

  @Expose()
  @ApiProperty({ description: 'Proposer information', type: ProposerDto })
  @Type(() => ProposerDto)
  proposer: ProposerDto;

  @Expose()
  @ApiPropertyOptional({ description: 'Assets to burn in this proposal', type: [BurnAssetDto] })
  @Type(() => BurnAssetDto)
  burnAssets?: BurnAssetDto[];

  @Expose()
  @ApiPropertyOptional({
    description: 'Lovelace amount to distribute for DISTRIBUTION proposals (as string)',
    example: '100000000',
  })
  distributionLovelaceAmount?: string;

  @Expose()
  @ApiPropertyOptional({
    description: 'Distribution info calculated from snapshot (holders, amounts, etc.)',
    type: DistributionInfoDto,
  })
  @Type(() => DistributionInfoDto)
  distributionInfo?: DistributionInfoDto;

  @Expose()
  @ApiPropertyOptional({
    description: 'Distribution execution status (only for DISTRIBUTION proposals that have started execution)',
    type: DistributionStatusDto,
  })
  @Type(() => DistributionStatusDto)
  distributionStatus?: DistributionStatusDto;

  @Expose()
  @ApiPropertyOptional({ description: 'Fungible tokens for staking', type: [StakingTokenDto] })
  @Type(() => StakingTokenDto)
  fungibleTokens?: StakingTokenDto[];

  @Expose()
  @ApiPropertyOptional({ description: 'Non-fungible tokens for staking', type: [StakingTokenDto] })
  @Type(() => StakingTokenDto)
  nonFungibleTokens?: StakingTokenDto[];

  @Expose()
  @ApiPropertyOptional({
    description: 'Marketplace actions with enriched asset data',
    type: [MarketplaceActionDetailDto],
  })
  @Type(() => MarketplaceActionDetailDto)
  marketplaceActions?: MarketplaceActionDetailDto[];
}
