import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';

import { Proposal } from '@/database/proposal.entity';
import { AssetType } from '@/types/asset.types';
import { VoteType } from '@/types/vote.types';

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

export class DistributionAssetDetailDto extends ProposalAssetDto {
  @Expose()
  @ApiProperty({ description: 'Amount to distribute', example: 1000000 })
  amount: number;
}

export class GetProposalDetailRes {
  @Expose()
  @ApiProperty({ description: 'Proposal entity', type: Proposal })
  proposal: Proposal;

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
  @ApiPropertyOptional({ description: 'Assets to distribute in this proposal', type: [DistributionAssetDetailDto] })
  @Type(() => DistributionAssetDetailDto)
  distributionAssets?: DistributionAssetDetailDto[];
}
