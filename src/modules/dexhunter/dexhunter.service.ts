import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import CardanoWasm, { FixedTransaction } from '@emurgo/cardano-serialization-lib-nodejs';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Vault } from '@/database/vault.entity';
import { BlockchainService } from '@/modules/vaults/processing-tx/onchain/blockchain.service';
import { getUtxosExtract } from '@/modules/vaults/processing-tx/onchain/utils/lib';
import { TreasuryWalletService } from '@/modules/vaults/treasure/treasure-wallet.service';

export interface EstimateSwapInput {
  tokenIn: string; // Policy ID + Asset Name (or 'lovelace' for ADA)
  tokenOut: string; // Policy ID + Asset Name (or 'lovelace' for ADA)
  amountIn: number;
  slippage?: number; // Default 1% (0.01)
}

export interface EstimateSwapResponse {
  averagePrice: number;
  netPrice: number;
  totalOutput: number;
  totalOutputWithoutSlippage: number;
  batcherFee: number;
  dexhunterFee: number;
  partnerFee: number;
  deposits: number;
  totalFee: number;
  splits: SwapSplit[];
}

export interface SwapSplit {
  dex: string;
  amountIn: number;
  amountOut: number;
  priceImpact: number;
}

export interface ExecuteSwapInput {
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  slippage?: number;
}

export interface ExecuteSwapResponse {
  txHash: string;
  estimatedOutput: number;
  actualSlippage: number;
}

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
      projectId: this.configService.get<string>('BLOCKFROST_TESTNET_API_KEY'),
    });
    this.dexHunterBaseUrl = 'https://api-us.dexhunterv3.app';
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
          slippage: input.slippage || 0.01, // Default 1% slippage
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

    // First, get swap estimate for expected output
    const estimate = await this.estimateSwap({
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      amountIn: input.amountIn,
      slippage: input.slippage,
    });

    this.logger.log(`Estimated output: ${estimate.totalOutput} ${input.tokenOut}`);

    // Get UTXOs containing the tokens to swap
    const targetAssets =
      input.tokenIn === 'lovelace'
        ? []
        : [
            {
              token: input.tokenIn,
              amount: 1, // We need at least 1 token
            },
          ];

    const { utxos: serializedUtxos } = await getUtxosExtract(
      CardanoWasm.Address.from_bech32(address),
      this.blockfrost,
      {
        targetAssets: targetAssets.length > 0 ? targetAssets : undefined,
        targetAdaAmount: input.tokenIn === 'lovelace' ? input.amountIn * 1_000_000 + 10_000_000 : undefined, // Add 10 ADA buffer for fees
        minAda: 1000000,
        maxUtxos: 20,
      }
    );

    if (serializedUtxos.length === 0) {
      throw new Error('No UTXOs available in treasury wallet to fund swap transaction');
    }

    this.logger.log(`Collected ${serializedUtxos.length} UTXOs for swap`);

    // Build swap transaction using DexHunter API
    const swapResponse = await fetch(`${this.dexHunterBaseUrl}/swap/swap`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Partner-Id': this.dexHunterApiKey,
      },
      body: JSON.stringify({
        token_in: input.tokenIn,
        token_out: input.tokenOut,
        amount_in: input.amountIn,
        slippage: input.slippage || 0.01,
        buyer_address: address, // Treasury wallet receives the output
        utxos: serializedUtxos,
      }),
    });

    if (!swapResponse.ok) {
      const errorText = await swapResponse.text();
      throw new Error(`DexHunter swap API error: ${swapResponse.status} - ${errorText}`);
    }

    const swapData = await swapResponse.json();

    if (!swapData.cbor) {
      throw new Error('No transaction CBOR returned from DexHunter');
    }

    this.logger.log('Swap transaction built successfully');

    // Sign the transaction with treasury wallet private key
    const privateKey = await this.treasuryWalletService.getTreasuryWalletPrivateKey(vaultId);
    const txToSign = FixedTransaction.from_bytes(Buffer.from(swapData.cbor, 'hex'));
    txToSign.sign_and_add_vkey_signature(privateKey);
    const signedTxHex = Buffer.from(txToSign.to_bytes()).toString('hex');

    this.logger.log('Swap transaction signed with treasury wallet');

    // Submit the transaction
    const submitResponse = await this.blockchainService.submitTransaction({
      transaction: signedTxHex,
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

  /**
   * Sign a transaction using the vault's treasury wallet private key
   *
   * @param vaultId - The vault ID
   * @param txHex - Transaction hex to sign
   * @returns Signed transaction hex
   */
  private async signTransaction(vaultId: string, txHex: string): Promise<string> {
    try {
      const privateKey = await this.treasuryWalletService.getTreasuryWalletPrivateKey(vaultId);
      const txToSign = FixedTransaction.from_bytes(Buffer.from(txHex, 'hex'));
      txToSign.sign_and_add_vkey_signature(privateKey);
      return Buffer.from(txToSign.to_bytes()).toString('hex');
    } catch (error) {
      this.logger.error(`Failed to sign transaction for vault ${vaultId}`, error);
      throw new Error(`Failed to sign transaction: ${error.message}`);
    }
  }
}
