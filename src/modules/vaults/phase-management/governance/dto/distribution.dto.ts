import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

/**
 * DTO for creating a distribution proposal
 * Contains the amount of ADA (in lovelace) to distribute to VT holders
 */
export class CreateDistributionDto {
  @ApiProperty({
    description: 'Amount to distribute in lovelace (1 ADA = 1,000,000 lovelace)',
    example: 100000000,
  })
  @IsNumber()
  @IsNotEmpty()
  @Min(2000000, { message: 'Minimum distribution amount is 2 ADA (2,000,000 lovelace)' })
  lovelaceAmount: number;

  @ApiProperty({
    description: 'Optional description for the distribution',
    required: false,
  })
  @IsOptional()
  @IsString()
  description?: string;
}

/**
 * Distribution batch status tracking
 */
export enum DistributionBatchStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  RETRY_PENDING = 'retry_pending',
}

/**
 * Distribution batch information stored in proposal metadata
 * Note: txHash is NOT stored here - it's stored in the Transaction entity
 */
export interface DistributionBatch {
  batchId: string;
  batchNumber: number;
  totalBatches: number;
  recipientCount: number;
  lovelaceAmount: string; // Total lovelace in this batch
  status: DistributionBatchStatus;
  claimIds: string[];
  transactionId?: string; // Reference to Transaction entity
  retryCount: number;
  lastAttempt?: string;
  error?: string;
}

/**
 * Distribution proposal metadata stored in proposal.metadata.distribution
 * Simplified version - doesn't store redundant data that can be fetched from related entities
 */
export interface DistributionMetadata {
  totalLovelaceToDistribute: string;
  totalRecipients: number;
  lovelacePerHolder: string; // Average, actual amounts may vary based on VT proportion
  minLovelacePerHolder: string;
  batches: DistributionBatch[];
  completedBatches: number;
  failedBatches: number;
}

/**
 * Treasury balance information for UI
 */
export class TreasuryBalanceDto {
  @ApiProperty({ description: 'Balance in lovelace', example: 100000000 })
  @Expose()
  lovelace: number;

  @ApiProperty({ description: 'Balance formatted in ADA', example: '100.000000' })
  @Expose()
  lovelaceFormatted: string;
}

/**
 * Response DTO for distribution info endpoint
 */
export class GetDistributionInfoRes {
  @ApiProperty({ description: 'Treasury wallet balance', type: TreasuryBalanceDto })
  @Expose()
  treasuryBalance: TreasuryBalanceDto;

  @ApiProperty({ description: 'Number of VT holders who will receive distribution', example: 150 })
  @Expose()
  vtHolderCount: number;

  @ApiProperty({
    description: 'Minimum ADA required for distribution (to cover 2 ADA per holder)',
    example: 300,
  })
  @Expose()
  minDistributableAda: number;

  @ApiProperty({
    description: 'Maximum ADA available for distribution (treasury balance)',
    example: 1000,
  })
  @Expose()
  maxDistributableAda: number;

  @ApiProperty({
    description: 'Minimum ADA per holder (Cardano minimum UTXO requirement)',
    example: 2,
  })
  @Expose()
  minAdaPerHolder: number;

  @ApiProperty({
    description: 'Estimated ADA per holder if distributed equally',
    example: 6.67,
    required: false,
  })
  @Expose()
  estimatedAdaPerHolder?: number;

  @ApiProperty({ description: 'Whether vault has a treasury wallet', example: true })
  @Expose()
  hasTreasuryWallet: boolean;

  @ApiProperty({
    description: 'Warning messages about distribution limitations',
    type: [String],
    example: ['Treasury balance is low'],
  })
  @Expose()
  warnings: string[];
}

/**
 * Distribution batch status for UI display
 */
export class DistributionBatchDto {
  @ApiProperty({ description: 'Unique batch identifier' })
  @Expose()
  batchId: string;

  @ApiProperty({ description: 'Batch number in sequence', example: 1 })
  @Expose()
  batchNumber: number;

  @ApiProperty({ description: 'Total number of batches', example: 5 })
  @Expose()
  totalBatches: number;

  @ApiProperty({ description: 'Number of recipients in this batch', example: 40 })
  @Expose()
  recipientCount: number;

  @ApiProperty({ description: 'Total lovelace amount in this batch' })
  @Expose()
  lovelaceAmount: string;

  @ApiProperty({
    description: 'Batch processing status',
    enum: ['pending', 'processing', 'completed', 'failed', 'retry_pending'],
  })
  @Expose()
  status: string;

  @ApiProperty({ description: 'Transaction ID reference', required: false })
  @Expose()
  transactionId?: string;

  @ApiProperty({ description: 'Transaction hash from transaction entity', required: false })
  @Expose()
  txHash?: string;

  @ApiProperty({ description: 'Number of retry attempts', example: 0 })
  @Expose()
  retryCount: number;

  @ApiProperty({ description: 'Last processing attempt timestamp', required: false })
  @Expose()
  lastAttempt?: string;

  @ApiProperty({ description: 'Error message if failed', required: false })
  @Expose()
  error?: string;
}

/**
 * Distribution info response for internal service use
 */
export interface DistributionInfo {
  treasuryBalance: {
    lovelace: number;
    lovelaceFormatted: string; // In ADA
  };
  vtHolderCount: number;
  minDistributableAda: number; // Minimum ADA needed to distribute to all holders
  maxDistributableAda: number; // Maximum ADA available in treasury
  minAdaPerHolder: number; // Minimum ~2 ADA
  estimatedAdaPerHolder?: number; // Based on equal distribution
  hasTreasuryWallet: boolean;
  warnings: string[];
}

/**
 * Recipient information for distribution (internal use)
 */
export interface DistributionRecipient {
  address: string;
  vtBalance: bigint;
  lovelaceShare: bigint;
  userId?: string;
}
