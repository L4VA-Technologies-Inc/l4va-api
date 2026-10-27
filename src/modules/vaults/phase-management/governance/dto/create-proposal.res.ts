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

/**
 * Native transfer the user's own wallet must broadcast to pay an EVM
 * governance fee. There is no pre-built transaction to sign here — unlike
 * Cardano, the wallet constructs and sends the transfer itself.
 */
export class EvmFeePaymentDto {
  @Expose()
  @ApiProperty({ description: 'Fee recipient address', example: '0x1234...' })
  to: string;

  @Expose()
  @ApiProperty({ description: 'Amount to send, in wei (decimal string)', example: '1000000000000000' })
  value: string;

  @Expose()
  @ApiProperty({ description: 'Chain the payment must be sent on', example: 46630 })
  chainId: number;

  @Expose()
  @ApiProperty({ description: 'Fee amount in wei (decimal string)', example: '1000000000000000' })
  feeAmount: string;
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

  @Expose()
  @ApiProperty({
    description: 'Whether payment is required before proposal becomes active',
    example: false,
    required: false,
  })
  requiresPayment?: boolean;

  @Expose()
  @ApiProperty({
    description: 'Presigned transaction hex for governance fee payment (if payment required)',
    example: '84a4008182...',
    required: false,
  })
  presignedTx?: string;

  @Expose()
  @ApiProperty({
    description: 'Fee amount in lovelace (Cardano) or wei (EVM, as a decimal string), if payment required',
    example: 5000000,
    required: false,
  })
  feeAmount?: number | string;

  @Expose()
  @ApiProperty({
    description:
      'Native payment parameters for EVM (Robinhood) vaults. The wallet sends this transfer itself, ' +
      'then posts the resulting hash to submit-fee-payment. Absent for Cardano vaults, which get presignedTx instead.',
    type: EvmFeePaymentDto,
    required: false,
  })
  @Type(() => EvmFeePaymentDto)
  evmPayment?: EvmFeePaymentDto;
}
