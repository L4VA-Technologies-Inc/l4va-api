import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsEnum, IsOptional, IsArray, IsDateString } from 'class-validator';

import { ProposalType } from '@/types/proposal.types';

export class CreateProposalReq {
  @ApiProperty({
    description: 'Title of the proposal',
    example: 'Sell Asset XYZ',
  })
  @IsNotEmpty()
  @IsString()
  title: string;

  @ApiProperty({
    description: 'Detailed description of the proposal',
    example: 'Proposal to sell Asset XYZ at current market price...',
  })
  @IsNotEmpty()
  @IsString()
  description: string;

  @ApiProperty({
    description: 'Type of proposal',
    enum: ProposalType,
    example: ProposalType.DISTRIBUTION,
  })
  @IsEnum(ProposalType)
  type: ProposalType;

  @ApiProperty({
    description: 'Start date and time when voting begins',
    example: '2025-08-05T10:00:00.000Z',
    type: 'string',
    format: 'date-time',
  })
  @IsNotEmpty()
  @IsDateString()
  startDate: string;

  @ApiProperty({
    description: 'Additional metadata for the proposal',
    required: false,
    example: { assetId: 'xyz-123', targetPrice: '1000' },
  })
  @IsOptional()
  metadata?: Record<string, any>;

  @ApiProperty({
    description: 'Voting options',
    example: ['Yes', 'No', 'Abstain'],
  })
  @IsArray()
  @IsString({ each: true })
  options: string[];
}
