import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { FixedTransaction } from '@emurgo/cardano-serialization-lib-nodejs';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Vault } from '@/database/vault.entity';
import { BlockchainService } from '@/modules/vaults/processing-tx/onchain/blockchain.service';
import { TreasuryWalletService } from '@/modules/vaults/treasure/treasure-wallet.service';

export interface EstimateSwapInput {
  /**
   * Token being sold (input token)
   */
  tokenIn: string;

  /**
   * Token being bought (output token)
   */
  tokenOut: string;

  /**
   * Amount of input token to swap (in base units)
   */
  amountIn: number;

  /**
   * Maximum acceptable slippage tolerance as a percentage
   */
  slippage?: number;
}

export interface EstimateSwapResponse {
  /**
   * Average exchange rate for the token pair across all DEXes
   * - Expressed as: 1 TokenIn = X TokenOut
   * - Used for reference pricing
   * @example 0.00001234 (1 SNEK = 0.00001234 ADA)
   */
  averagePrice: number;

  /**
   * Net price after all fees are applied
   * - Accounts for batcher fees, protocol fees, and slippage
   * - This is the effective exchange rate you'll receive
   * @example 0.00001200 (actual price after fees)
   */
  netPrice: number;

  /**
   * Total amount of output token you will receive (in base units)
   * - Includes slippage protection
   * - This is the minimum guaranteed output
   * @example 4050000 (4.05 ADA in lovelace)
   */
  totalOutput: number;

  /**
   * Estimated output without slippage protection (in base units)
   * - Best case scenario if price doesn't move
   * - Used to calculate actual slippage
   * @example 4100000 (4.10 ADA in lovelace)
   */
  totalOutputWithoutSlippage: number;

  /**
   * Fee charged by the batcher for transaction execution (in lovelace)
   * - Fixed fee for processing the swap transaction
   * - Typically 1-2 ADA depending on the DEX
   * @example 2000000 (2 ADA)
   */
  batcherFee: number;

  /**
   * Fee charged by DexHunter protocol (in lovelace)
   * - Protocol fee for routing and optimization services
   * @example 25000 (0.025 ADA)
   */
  dexhunterFee: number;

  /**
   * Fee shared with integration partner (in lovelace)
   * - Revenue share for partners using DexHunter API
   * @example 25000 (0.025 ADA)
   */
  partnerFee: number;

  /**
   * Refundable deposit required for the transaction (in lovelace)
   * - Temporary deposit locked during swap execution
   * - Returned after transaction completes
   * @example 2000000 (2 ADA)
   */
  deposits: number;

  /**
   * Sum of all fees (batcher + dexhunter + partner fees) (in lovelace)
   * - Does not include deposits (which are refundable)
   * @example 4050000 (4.05 ADA total fees)
   */
  totalFee: number;

  /**
   * Array of swap routes split across multiple DEXes
   * - DexHunter optimizes by splitting orders across DEXes for best price
   * - Each split represents a portion of the trade on a specific DEX
   */
  splits: SwapSplit[];
}

/**
 * Represents a single swap route split on a specific DEX
 * DexHunter optimizes swaps by splitting orders across multiple DEXes
 * to minimize price impact and maximize output
 */
export interface SwapSplit {
  /**
   * Name of the DEX where this portion of the swap is executed
   */
  dex: string;

  /**
   * Amount of input token allocated to this DEX (in base units)
   */
  amountIn: number;

  /**
   * Expected output amount from this DEX split (in base units)
   */
  amountOut: number;

  /**
   * Price impact on this specific DEX (as percentage)
   */
  priceImpact: number;
}

export interface ExecuteSwapInput {
  /**
   * Token being sold (input token)
   */
  tokenIn: string;

  /**
   * Token being bought (output token)
   */
  tokenOut: string;

  /**
   * Amount of input token to swap (in base units)
   */
  amountIn: number;

  /**
   * Maximum acceptable slippage tolerance (as percentage)
   */
  slippage?: number;
}

export interface ExecuteSwapResponse {
  txHash: string;
  estimatedOutput: number;
  actualSlippage: number;
}

/**
 * Build Swap Flow
 * 1. Estimate Swap - Get price quote and fee breakdown
 * 2. Build Swap Transaction - Get unsigned transaction CBOR from DexHunter | /swap/build
 * 3. Sign Transaction - Sign with treasury wallet private key
 * 4. Submit Transaction - Submit signed transaction to blockchain | /swap/sign
 *
 * @see https://docs.dexhunter.io for complete DexHunter API documentation
 */
@Injectable()
export class DexHunterService {
  private readonly logger = new Logger(DexHunterService.name);

  private readonly blockfrost: BlockFrostAPI;
  private readonly dexHunterBaseUrl: string;
  private readonly dexHunterApiKey: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService,
    private readonly treasuryWalletService: TreasuryWalletService,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>
  ) {
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });
    this.dexHunterBaseUrl = this.configService.get<string>('DEXHUNTER_BASE_URL');
    this.dexHunterApiKey = this.configService.get<string>('DEXHUNTER_API_KEY');
  }

  /**
   * Estimate a token swap using DexHunter API
   * Provides price quotes and fee breakdown before executing the swap
   *
   * @param input - Swap estimation parameters
   * @returns Estimated swap details including output amount and fees
   */
  async estimateSwap(input: EstimateSwapInput): Promise<EstimateSwapResponse> {
    this.logger.log(`Estimating swap: ${input.amountIn} ${input.tokenIn} -> ${input.tokenOut}`);

    try {
      const response = await fetch(`${this.dexHunterBaseUrl}/swap/estimate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Partner-Id': this.dexHunterApiKey,
        },
        body: JSON.stringify({
          token_in: input.tokenIn,
          token_out: input.tokenOut,
          amount_in: input.amountIn,
          slippage: input.slippage || 0.5, // Default 1% slippage
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`DexHunter API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();

      this.logger.log(`Swap estimate: ${data.total_output} ${input.tokenOut} (price: ${data.net_price})`);

      return {
        averagePrice: data.average_price,
        netPrice: data.net_price,
        totalOutput: data.total_output,
        totalOutputWithoutSlippage: data.total_output_without_slippage,
        batcherFee: data.batcher_fee,
        dexhunterFee: data.dexhunter_fee,
        partnerFee: data.partner_fee,
        deposits: data.deposits,
        totalFee: data.total_fee,
        splits: data.splits || [],
      };
    } catch (error) {
      this.logger.error('Failed to estimate swap', error);
      throw new Error(`Failed to estimate swap: ${error.message}`);
    }
  }

  /**
   * Execute a token swap using DexHunter API and vault's treasury wallet
   * Swaps tokens to ADA and deposits back to treasury wallet
   *
   * Flow:
   * 1. Get swap estimate
   * 2. Build transaction via /swap/build
   * 3. Sign transaction with treasury wallet private key
   * 4. Submit signed transaction via /swap/sign
   * 5. Submit to blockchain
   *
   * @param vaultId - The vault ID that owns the tokens
   * @param input - Swap execution parameters
   * @returns Transaction hash and swap details
   */
  async executeSwap(vaultId: string, input: ExecuteSwapInput): Promise<ExecuteSwapResponse> {
    this.logger.log(`Executing swap for vault ${vaultId}: ${input.amountIn} ${input.tokenIn} -> ${input.tokenOut}`);

    // Get vault and verify treasury wallet exists
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      relations: ['treasury_wallet'],
    });

    if (!vault) {
      throw new Error(`Vault ${vaultId} not found`);
    }

    if (!vault.treasury_wallet) {
      throw new Error(`Treasury wallet not found for vault ${vaultId}`);
    }

    const address = vault.treasury_wallet.treasury_address;
    this.logger.log(`Using treasury wallet address: ${address}`);

    // Step 1: Get swap estimate for expected output
    const estimate = await this.estimateSwap({
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      amountIn: input.amountIn,
      slippage: input.slippage,
    });

    this.logger.log(`Estimated output: ${estimate.totalOutput} ${input.tokenOut}`);

    // Step 2: Build swap transaction using DexHunter API
    this.logger.log('Building swap transaction...');
    const swapResponse = await fetch(`${this.dexHunterBaseUrl}/swap/build`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Partner-Id': this.dexHunterApiKey,
      },
      body: JSON.stringify({
        buyer_address: address, // Treasury wallet receives the output
        token_in: input.tokenIn,
        token_out: input.tokenOut,
        slippage: input.slippage || 0.5,
        amount_in: input.amountIn,
        tx_optimization: true, // Enable DEX splitting for better prices
      }),
    });

    if (!swapResponse.ok) {
      const errorText = await swapResponse.text();
      throw new Error(`DexHunter /swap/build API error: ${swapResponse.status} - ${errorText}`);
    }

    const swapData = await swapResponse.json();

    if (!swapData.cbor) {
      throw new Error('No transaction CBOR returned from DexHunter');
    }

    this.logger.log('Swap transaction built successfully');

    // Step 3: Sign the transaction with treasury wallet private key
    this.logger.log('Signing transaction with treasury wallet...');
    const privateKey = await this.treasuryWalletService.getTreasuryWalletPrivateKey(vaultId);
    const txToSign = FixedTransaction.from_bytes(Buffer.from(swapData.cbor, 'hex'));
    txToSign.sign_and_add_vkey_signature(privateKey);
    const witnessSet = txToSign.witness_set();
    const vkeyWitnesses = witnessSet.vkeys();

    // Extract signatures from witness set
    const signatures: string[] = [];
    for (let i = 0; i < vkeyWitnesses.len(); i++) {
      const vkey = vkeyWitnesses.get(i);
      signatures.push(Buffer.from(vkey.to_bytes()).toString('hex'));
    }

    this.logger.log(`Transaction signed with ${signatures.length} signature(s)`);

    // Step 4: Submit signed transaction to DexHunter /swap/sign endpoint
    this.logger.log('Submitting signed transaction to DexHunter...');
    const signResponse = await fetch(`${this.dexHunterBaseUrl}/swap/sign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Partner-Id': this.dexHunterApiKey,
      },
      body: JSON.stringify({
        txCbor: swapData.cbor,
        signatures: signatures,
      }),
    });

    if (!signResponse.ok) {
      const errorText = await signResponse.text();
      throw new Error(`DexHunter /swap/sign API error: ${signResponse.status} - ${errorText}`);
    }

    const signData = await signResponse.json();

    if (!signData.cbor) {
      throw new Error('No signed transaction CBOR returned from DexHunter');
    }

    this.logger.log('Signed transaction received from DexHunter');

    // Step 5: Submit the final signed transaction to blockchain
    const submitResponse = await this.blockchainService.submitTransaction({
      transaction: signData.cbor,
    });

    this.logger.log(`Swap transaction submitted successfully. TxHash: ${submitResponse.txHash}`);

    // Calculate actual slippage
    const actualSlippage =
      ((estimate.totalOutputWithoutSlippage - estimate.totalOutput) / estimate.totalOutputWithoutSlippage) * 100;

    return {
      txHash: submitResponse.txHash,
      estimatedOutput: estimate.totalOutput,
      actualSlippage: actualSlippage,
    };
  }
}
