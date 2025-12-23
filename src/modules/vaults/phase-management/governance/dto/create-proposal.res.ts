import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';

import { ProposalStatus } from '@/types/proposal.types';

export class CreatedProposalDto {
  @Expose()
  @ApiProperty({ description: 'Proposal ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  id: string;

  @Expose()
  @ApiProperty({ description: 'Vault ID', example: '123e4567-e89b-12d3-a456-426614174001' })
  vaultId: string;

  @Expose()
  @ApiProperty({ description: 'Proposal title', example: 'Stake NFTs in the Cardano Summit staking pool' })
  title: string;

  @Expose()
  @ApiProperty({ description: 'Proposal description', example: 'This proposal aims to stake our vault NFTs...' })
  description: string;

  @Expose()
  @ApiProperty({ description: 'Creator user ID', example: '123e4567-e89b-12d3-a456-426614174002' })
  creatorId: string;

  @Expose()
  @ApiProperty({ description: 'Proposal status', enum: ProposalStatus, example: ProposalStatus.ACTIVE })
  status: ProposalStatus;

  @Expose()
  @ApiProperty({ description: 'Proposal creation date', example: '2023-08-15T10:30:00Z' })
  createdAt: Date;

  @Expose()
  @ApiProperty({ description: 'Proposal end date', example: '2023-08-22T10:30:00Z' })
  endDate: Date;
}

export class CreateProposalRes {
  @Expose()
  @ApiProperty({ description: 'Whether the proposal was created successfully', example: true })
  success: boolean;

  @Expose()
  @ApiProperty({ description: 'Response message', example: 'Proposal created successfully' })
  message: string;

  @Expose()
  @ApiProperty({ description: 'Created proposal data', type: CreatedProposalDto })
  @Type(() => CreatedProposalDto)
  proposal: CreatedProposalDto;
}
