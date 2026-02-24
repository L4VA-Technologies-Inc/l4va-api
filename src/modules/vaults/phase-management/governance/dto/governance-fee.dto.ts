import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsString, IsEnum, IsNotEmpty, IsArray } from 'class-validator';

/**
 * Response DTO for getting governance fees
 */
export class GetGovernanceFeesRes {
  @ApiProperty({
    description: 'Governance fee for staking proposals (in lovelace)',
    example: 5000000,
  })
  @Expose()
  proposalFeeStaking: number;

  @ApiProperty({
    description: 'Governance fee for distribution proposals (in lovelace)',
    example: 5000000,
  })
  @Expose()
  proposalFeeDistribution: number;

  @ApiProperty({
    description: 'Governance fee for termination proposals (in lovelace)',
    example: 10000000,
  })
  @Expose()
  proposalFeeTermination: number;

  @ApiProperty({
    description: 'Governance fee for burning proposals (in lovelace)',
    example: 3000000,
  })
  @Expose()
  proposalFeeBurning: number;

  @ApiProperty({
    description: 'Governance fee for marketplace action proposals (in lovelace)',
    example: 5000000,
  })
  @Expose()
  proposalFeeMarketplaceAction: number;

  @ApiProperty({
    description: 'Governance fee for expansion proposals (in lovelace)',
    example: 10000000,
  })
  @Expose()
  proposalFeeExpansion: number;

  @ApiProperty({
    description: 'Governance fee for voting (in lovelace)',
    example: 0,
  })
  @Expose()
  votingFee: number;
}

/**
 * Response DTO for building a governance fee transaction
 */
export class BuildGovernanceFeeTransactionRes {
  @ApiProperty({
    description: 'Presigned transaction hex that user needs to sign',
    example: '84a4008182...',
  })
  @Expose()
  presignedTx: string;

  @ApiProperty({
    description: 'Fee amount paid in lovelace',
    example: 5000000,
  })
  @Expose()
  feeAmount: number;
}

/**
 * Request DTO for building a proposal fee transaction
 */
export class BuildProposalFeeTransactionReq {
  @ApiProperty({
    description: 'User wallet address',
    example: 'addr1...',
  })
  @IsString()
  userAddress: string;

  @ApiProperty({
    description: 'Type of proposal',
    example: 'staking',
    enum: ['staking', 'distribution', 'termination', 'burning', 'marketplace_action', 'expansion'],
  })
  @IsEnum(['staking', 'distribution', 'termination', 'burning', 'marketplace_action', 'expansion'])
  proposalType: string;
}

/**
 * Request DTO for submitting governance fee payment transaction
 */
export class SubmitProposalFeePaymentReq {
  @ApiProperty({
    description: 'CBOR encoded transaction',
    example: '84a400...',
  })
  @IsString()
  @IsNotEmpty()
  transaction: string;

  @ApiProperty({
    description: 'Array of CBOR encoded signatures',
    example: ['84a400...'],
    required: false,
  })
  @IsArray()
  @IsString({ each: true })
  signatures: string[];
}
