import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsEnum, IsOptional, IsArray } from 'class-validator';

export enum ProposalType {
  ASSET_SALE = 'asset_sale',
  VAULT_STRATEGY = 'vault_strategy',
  PARAMETER_CHANGE = 'parameter_change',
  OTHER = 'other',
}

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
    example: ProposalType.ASSET_SALE,
  })
  @IsEnum(ProposalType)
  type: ProposalType;

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
