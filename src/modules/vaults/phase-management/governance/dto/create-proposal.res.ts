import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class CreateProposalProposalDto {
  @Expose()
  @ApiProperty({ description: 'Proposal ID', example: '123e4567-e89b-12d3-a456-426614174000' })
  id: string;

  @Expose()
  @ApiProperty({ description: 'Vault ID', example: '123e4567-e89b-12d3-a456-426614174001' })
  vaultId: string;

  @Expose()
  @ApiProperty({ description: 'Proposal title', example: 'Stake NFTs in the Cardano Summit staking pool' })
  title: string;
}

export class CreateProposalRes {
  @Expose()
  @ApiProperty({ description: 'Whether the proposal was created successfully', example: true })
  success: boolean;

  @Expose()
  @ApiProperty({ description: 'Response message', example: 'Proposal created successfully' })
  message: string;

  @Expose()
  @ApiProperty({ description: 'Created proposal data', type: CreateProposalProposalDto })
  proposal: CreateProposalProposalDto;
}
