import { ApiProperty } from '@nestjs/swagger';

/**
 * Result of an LP token operation
 */
export class LpTokenOperationResult {
  @ApiProperty({
    description: 'Whether the operation was successful',
    example: true,
  })
  success: boolean;

  @ApiProperty({
    description: 'Transaction hash if the operation was successful',
    example: '0x123...abc',
    required: false,
  })
  transactionHash?: string;

  @ApiProperty({
    description: 'Error message if the operation failed',
    example: 'Insufficient balance',
    required: false,
  })
  error?: string;

  constructor(partial: Partial<LpTokenOperationResult>) {
    Object.assign(this, partial);
  }
}

/**
 * Parameters for extracting LP tokens
 */
export interface ExtractLpTokensParams {
  /**
   * ID of the vault to extract tokens from
   */
  vaultId: string;

  /**
   * Wallet address to send the tokens to
   */
  walletAddress: string;

  /**
   * Amount of LP tokens to extract (in smallest unit as string)
   */
  amount: string;
}

/**
 * Parameters for burning LP tokens
 */
export interface BurnLpTokensParams {
  /**
   * Wallet address that holds the LP tokens
   */
  walletAddress: string;

  /**
   * Amount of LP tokens to burn (in smallest unit as string)
   */
  amount: string;
}

/**
 * Parameters for dropping LP tokens
 */
export interface DistributeLpTokensParams {
  /**
   * Wallet address to receive the LP tokens
   */
  walletAddress: string;

  /**
   * Amount of LP tokens to drop (in smallest unit as string)
   */
  amount: string;
}
