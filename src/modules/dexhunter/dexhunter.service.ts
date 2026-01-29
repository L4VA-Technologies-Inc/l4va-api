import { FixedTransaction } from '@emurgo/cardano-serialization-lib-nodejs';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { EstimateSwapInput, EstimateSwapResponse } from './dto/estimate-swap.dto';
import { ExecuteSwapInput, ExecuteSwapResponse } from './dto/execute-swap.dto';

import { Vault } from '@/database/vault.entity';
import { BlockchainService } from '@/modules/vaults/processing-tx/onchain/blockchain.service';
import { TreasuryWalletService } from '@/modules/vaults/treasure/treasure-wallet.service';

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
  private readonly dexHunterBaseUrl: string;
  private readonly dexHunterApiKey: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService,
    private readonly treasuryWalletService: TreasuryWalletService,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>
  ) {
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
    this.logger.log(`Executing swap for vault ${vaultId}: ${input.amountIn} ${input.tokenIn} -> ${'ADA'}`);

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
      tokenOut: 'ADA',
      amountIn: input.amountIn,
      slippage: input.slippage,
    });

    this.logger.log(`Estimated output: ${estimate.totalOutput} ADA`);

    // Step 2: Build swap transaction using DexHunter API
    const swapResponse = await fetch(`${this.dexHunterBaseUrl}/swap/build`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Partner-Id': this.dexHunterApiKey,
      },
      body: JSON.stringify({
        buyer_address: address, // Treasury wallet receives the output
        token_in: input.tokenIn,
        token_out: 'ADA',
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

    // Step 3: Sign the transaction with BOTH keys
    this.logger.log('Signing transaction with treasury wallet...');
    const { privateKey, stakePrivateKey } = await this.treasuryWalletService.getTreasuryWalletPrivateKey(vaultId);

    const txToSign = FixedTransaction.from_bytes(Buffer.from(swapData.cbor, 'hex'));

    txToSign.sign_and_add_vkey_signature(privateKey);
    txToSign.sign_and_add_vkey_signature(stakePrivateKey);

    const witnessSet = txToSign.witness_set();
    const witnessSetHex = Buffer.from(witnessSet.to_bytes()).toString('hex');

    this.logger.log('Transaction signed with both payment and stake keys');

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
        signatures: witnessSetHex, // Send as single hex string
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
