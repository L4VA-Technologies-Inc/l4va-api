import { ApiProperty } from '@nestjs/swagger';

import { DistributionAssetDto, FungibleTokenDto, NonFungibleTokenDto } from './create-proposal.req';

import { ProposalStatus } from '@/types/proposal.types';

// For base proposal data
class BaseProposalDto {
  @ApiProperty({
    description: 'Unique identifier of the proposal',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  id: string;

  @ApiProperty({
    description: 'Vault ID this proposal belongs to',
    example: '123e4567-e89b-12d3-a456-426614174001',
  })
  vaultId: string;

  @ApiProperty({
    description: 'Title of the proposal',
    example: 'Stake NFTs in the Cardano Summit staking pool',
  })
  title: string;

  @ApiProperty({
    description: 'Detailed description of the proposal',
    example: 'This proposal suggests staking our NFTs in the Cardano Summit staking pool for rewards...',
  })
  description: string;

  @ApiProperty({
    description: 'User ID of the proposal creator',
    example: '123e4567-e89b-12d3-a456-426614174002',
  })
  creatorId: string;

  @ApiProperty({
    description: 'Current status of the proposal',
    enum: ProposalStatus,
    example: ProposalStatus.ACTIVE,
  })
  status: ProposalStatus;

  @ApiProperty({
    description: 'Creation timestamp of the proposal',
    example: '2023-08-15T10:30:00Z',
  })
  createdAt: Date;

  @ApiProperty({
    description: 'End date of the voting period',
    example: '2023-08-22T10:30:00Z',
  })
  endDate: string;

  @ApiProperty({
    description: 'Indicates if the proposal allows abstain votes',
    example: true,
  })
  abstain: boolean;

  @ApiProperty({ required: false, type: [FungibleTokenDto] })
  fungibleTokens?: FungibleTokenDto[];

  @ApiProperty({ required: false, type: [NonFungibleTokenDto] })
  nonFungibleTokens?: NonFungibleTokenDto[];

  @ApiProperty({ required: false, type: [DistributionAssetDto] })
  distributionAssets?: DistributionAssetDto[];

  @ApiProperty({ required: false })
  terminationReason?: string;

  @ApiProperty({ required: false })
  terminationDate?: Date;

  @ApiProperty({
    description: 'Array of asset IDs to burn',
    example: ['assetid1', 'assetid2', 'assetid3'],
    required: false,
    type: [String],
  })
  burnAssets?: string[];
}

// For active proposals with votes
class ActiveProposalDto extends BaseProposalDto {
  @ApiProperty({
    description: 'Vote percentages',
    example: {
      yes: 65,
      no: 35,
      abstain: 0, // Abstain percentage is 0 for non-abstain proposals
    },
  })
  votes: {
    yes: number;
    no: number;
    abstain: number;
  };
}

export type GetProposalsResItem = BaseProposalDto | ActiveProposalDto;

// Now update your service to use this return type
export class GetProposalsRes {
  @ApiProperty({
    description: 'List of proposals',
    type: [Object], // Can't specify union types directly in Swagger
    example: [
      {
        id: '123e4567-e89b-12d3-a456-426614174000',
        vaultId: '123e4567-e89b-12d3-a456-426614174001',
        title: 'Upcoming Proposal',
        description: 'This proposal is scheduled to start soon',
        creatorId: '123e4567-e89b-12d3-a456-426614174002',
        status: 'UPCOMING',
        createdAt: '2023-08-15T10:30:00Z',
        endDate: '2023-08-22T10:30:00Z',
      },
      {
        id: '123e4567-e89b-12d3-a456-426614174003',
        vaultId: '123e4567-e89b-12d3-a456-426614174001',
        title: 'Active Proposal',
        description: 'This proposal is currently being voted on',
        creatorId: '123e4567-e89b-12d3-a456-426614174002',
        status: 'ACTIVE',
        createdAt: '2023-08-14T10:30:00Z',
        endDate: '2023-08-21T10:30:00Z',
        votes: {
          yes: 65,
          no: 35,
        },
      },
    ],
  })
  proposals: GetProposalsResItem[];
}
