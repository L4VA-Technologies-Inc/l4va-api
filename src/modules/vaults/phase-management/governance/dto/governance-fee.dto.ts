import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { IsString, IsNotEmpty, IsArray, IsOptional } from 'class-validator';

/**
 * EVM governance fees, in wei as decimal strings. Denominated independently
 * of the lovelace fees above — these are not a conversion of them.
 */
export class EvmGovernanceFeesDto {
  @ApiProperty({ description: 'Staking proposal fee (wei)', example: '1000000000000000' })
  @Expose()
  proposalFeeStaking: string;

  @ApiProperty({ description: 'Distribution proposal fee (wei)', example: '1000000000000000' })
  @Expose()
  proposalFeeDistribution: string;

  @ApiProperty({ description: 'Termination proposal fee (wei)', example: '2000000000000000' })
  @Expose()
  proposalFeeTermination: string;

  @ApiProperty({ description: 'Burning proposal fee (wei)', example: '0' })
  @Expose()
  proposalFeeBurning: string;

  @ApiProperty({ description: 'Marketplace action proposal fee (wei)', example: '1000000000000000' })
  @Expose()
  proposalFeeMarketplaceAction: string;

  @ApiProperty({ description: 'Expansion proposal fee (wei)', example: '2000000000000000' })
  @Expose()
  proposalFeeExpansion: string;

  @ApiProperty({ description: 'Asset whitelist update proposal fee (wei)', example: '1000000000000000' })
  @Expose()
  proposalFeeAssetWhitelistUpdate: string;

  @ApiProperty({ description: 'Voting fee (wei)', example: '0' })
  @Expose()
  votingFee: string;
}

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
    description: 'Governance fee for asset whitelist update proposals (in lovelace)',
    example: 5000000,
  })
  @Expose()
  proposalFeeAssetWhitelistUpdate: number;

  @ApiProperty({
    description: 'Governance fee for voting (in lovelace)',
    example: 0,
  })
  @Expose()
  votingFee: number;

  @ApiProperty({
    description: 'EVM (Robinhood) governance fees, in wei. Clients use this block for EVM vaults.',
    type: EvmGovernanceFeesDto,
  })
  @Expose()
  @Type(() => EvmGovernanceFeesDto)
  evm: EvmGovernanceFeesDto;
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
 * Request DTO for submitting governance fee payment transaction
 */
export class SubmitProposalFeePaymentReq {
  @ApiProperty({
    description: 'CBOR encoded transaction (Cardano vaults)',
    example: '84a400...',
    required: false,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  transaction?: string;

  @ApiProperty({
    description: 'Array of CBOR encoded signatures (Cardano vaults)',
    example: ['84a400...'],
    required: false,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  signatures?: string[];

  @ApiProperty({
    description:
      'Hash of the native fee transfer already broadcast by the wallet (EVM vaults). ' +
      'Mutually exclusive with `transaction`.',
    example: '0xabc123...',
    required: false,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  txHash?: string;
}
