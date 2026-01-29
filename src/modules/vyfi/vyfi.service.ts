import { Buffer } from 'buffer';

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Address, FixedTransaction, PrivateKey } from '@emurgo/cardano-serialization-lib-nodejs';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom } from 'rxjs';
import { Repository } from 'typeorm';

import { BlockchainService } from '../vaults/processing-tx/onchain/blockchain.service';
import { MissingUtxoException } from '../vaults/processing-tx/onchain/exceptions/utxo-missing.exception';
import { getAddressFromHash, getUtxosExtract } from '../vaults/processing-tx/onchain/utils/lib';

import { Claim } from '@/database/claim.entity';
import { Transaction } from '@/database/transaction.entity';
import { ClaimStatus, ClaimType } from '@/types/claim.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

// Constants for VyFi pool creation
const VYFI_CONSTANTS = {
  PROCESSING_FEE: 1_900_000, // 1.9 ADA in lovelace
  MIN_POOL_ADA: 2_000_000, // 2 ADA in lovelace
  MIN_RETURN_ADA: 2_000_000, // 2 ADA in lovelace
  TOTAL_REQUIRED_ADA: 5_900_000, // 5.9 ADA in lovelace
  MIN_REMOVAL_LP_ADA: 3_900_000, // 3.9 ADA in lovelace
  METADATA_LABEL: '53554741',
};

@Injectable()
export class VyfiService {
  private readonly logger = new Logger(VyfiService.name);
  private readonly vyfiApiUrl = 'https://api.vyfi.io';
  private readonly adminSKey: string;
  private readonly adminAddress: string;
  private readonly adminHash: string;
  private readonly blockfrost: BlockFrostAPI;
  private readonly poolAddress: string;
  private readonly isMainnet: boolean;
  private readonly networkId: number;

  constructor(
    @InjectRepository(Claim)
    private claimRepository: Repository<Claim>,
    @InjectRepository(Transaction)
    private transactionRepository: Repository<Transaction>,
    private readonly httpService: HttpService,
    private readonly blockchainService: BlockchainService,
    private readonly configService: ConfigService
  ) {
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
    this.adminAddress = this.configService.get<string>('ADMIN_ADDRESS');
    this.adminHash = this.configService.get<string>('ADMIN_KEY_HASH');
    this.poolAddress = this.configService.get<string>('POOL_ADDRESS');
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    this.networkId = Number(this.configService.get<string>('NETWORK_ID')) || 0;
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });
  }

  async checkPool({
    networkId,
    tokenAUnit,
    tokenBUnit,
  }: {
    networkId: number;
    tokenAUnit: string;
    tokenBUnit: string;
  }): Promise<
    | {
        exists: boolean;
        data: any;
        error?: undefined;
      }
    | {
        exists: boolean;
        error: string;
        data?: undefined;
      }
  > {
    const url = `${this.vyfiApiUrl}/lp`;
    const queryParams = new URLSearchParams({
      networkId: networkId.toString(),
      tokenAUnit,
      tokenBUnit,
      v2: 'true',
    });

    try {
      const response = await firstValueFrom(this.httpService.get(`${url}?${queryParams.toString()}`));
      return {
        exists: true,
        data: response.data,
      };
    } catch (error) {
      if (error.response?.status === 500 || error.response?.status === 404) {
        return {
          exists: false,
          error: 'Pool does not exist',
        };
      }
      throw new Error(`Failed to check VyFi pool: ${error.message}`);
    }
  }

  async getPoolInfo(poolId: string): Promise<any> {
    try {
      const response = await firstValueFrom(this.httpService.get(`${this.vyfiApiUrl}/pool/${poolId}`));
      return response.data;
    } catch (error) {
      throw new Error(`Failed to get VyFi pool info: ${error.message}`);
    }
  }

  /**
   * Get pool info by token pair
   * Returns pool data including order address, LP token unit, and reserves
   */
  async getPoolByTokens(
    tokenAUnit: string,
    tokenBUnit: string = 'lovelace'
  ): Promise<{
    poolId: string;
    orderAddress: string;
    lpTokenUnit: string;
    reserveA: string;
    reserveB: string;
    tokenAUnit: string;
    tokenBUnit: string;
  } | null> {
    try {
      const poolCheck = await this.checkPool({
        networkId: this.networkId,
        tokenAUnit,
        tokenBUnit,
      });

      if (!poolCheck.exists || !poolCheck.data) {
        return null;
      }

      const poolData = poolCheck.data;
      return {
        poolId: poolData.poolId || poolData.id,
        orderAddress: poolData.orderAddress || poolData.order_address,
        lpTokenUnit: poolData.lpTokenUnit || poolData.lp_token_unit,
        reserveA: poolData.reserveA || poolData.reserve_a || '0',
        reserveB: poolData.reserveB || poolData.reserve_b || '0',
        tokenAUnit: poolData.tokenAUnit || poolData.token_a_unit || tokenAUnit,
        tokenBUnit: poolData.tokenBUnit || poolData.token_b_unit || tokenBUnit,
      };
    } catch (error) {
      this.logger.error(`Failed to get pool by tokens: ${error.message}`);
      return null;
    }
  }

  /**
   * Build CBOR datum for VyFi remove liquidity
   *
   * Datum structure (based on VyFi specification):
   * - Outer constructor (0): Contains return address + action
   * - Inner constructor (1): Remove liquidity action
   *   - Contains constructor (0) with minTokenA and minTokenB
   *
   * Correct structure:
   * Constructor 0 [
   *   address_bytes,
   *   Constructor 1 [
   *     Constructor 0 [ minTokenA, minTokenB ]
   *   ]
   * ]
   *
   * Example from VyFi:
   * d8799f5838{address}d87a9fd8799f1a{minA}1b{minB}ffffff
   *
   * @param returnAddress - Bech32 address where tokens should be returned
   * @param minTokenA - Minimum amount of tokenA to receive (0 for no slippage protection)
   * @param minTokenB - Minimum amount of tokenB/ADA to receive (0 for no slippage protection)
   */
  buildRemoveLiquidityDatum(returnAddress: string, minTokenA: number = 0, minTokenB: number = 0): string {
    // Convert bech32 address to raw bytes
    const addressObj = Address.from_bech32(returnAddress);
    const addressBytes = addressObj.to_bytes();

    // Build CBOR datum manually
    // Structure: Constructor 0 [ addressBytes, Constructor 1 [ Constructor 0 [ minTokenA, minTokenB ] ] ]

    let datum = '';

    // Start outer constructor 0 with indefinite array
    datum += 'd8799f'; // Tag 121 (constructor 0) + 9f (indefinite array start)

    // Add address as byte string
    const addrHex = Buffer.from(addressBytes).toString('hex');
    const addrLength = addressBytes.length;

    if (addrLength <= 23) {
      // Short byte string (length in single byte)
      datum += (0x40 + addrLength).toString(16).padStart(2, '0');
    } else if (addrLength <= 255) {
      // Byte string with 1-byte length
      datum += '58' + addrLength.toString(16).padStart(2, '0');
    } else {
      // Byte string with 2-byte length
      datum += '59' + addrLength.toString(16).padStart(4, '0');
    }
    datum += addrHex;

    // Inner constructor 1 (remove liquidity action) with indefinite array
    datum += 'd87a9f'; // Tag 122 (constructor 1) + 9f (indefinite array start)

    // Nested constructor 0 for min amounts (this was missing!)
    datum += 'd8799f'; // Tag 121 (constructor 0) + 9f (indefinite array start)

    // Add minTokenA as unsigned integer
    if (minTokenA === 0) {
      datum += '00';
    } else if (minTokenA <= 23) {
      datum += minTokenA.toString(16).padStart(2, '0');
    } else if (minTokenA <= 255) {
      datum += '18' + minTokenA.toString(16).padStart(2, '0');
    } else if (minTokenA <= 65535) {
      datum += '19' + minTokenA.toString(16).padStart(4, '0');
    } else if (minTokenA <= 4294967295) {
      datum += '1a' + minTokenA.toString(16).padStart(8, '0');
    } else {
      datum += '1b' + BigInt(minTokenA).toString(16).padStart(16, '0');
    }

    // Add minTokenB as unsigned integer
    if (minTokenB === 0) {
      datum += '00';
    } else if (minTokenB <= 23) {
      datum += minTokenB.toString(16).padStart(2, '0');
    } else if (minTokenB <= 255) {
      datum += '18' + minTokenB.toString(16).padStart(2, '0');
    } else if (minTokenB <= 65535) {
      datum += '19' + minTokenB.toString(16).padStart(4, '0');
    } else if (minTokenB <= 4294967295) {
      datum += '1a' + minTokenB.toString(16).padStart(8, '0');
    } else {
      datum += '1b' + BigInt(minTokenB).toString(16).padStart(16, '0');
    }

    // Close nested constructor 0 (min amounts)
    datum += 'ff';

    // Close inner constructor 1 (action)
    datum += 'ff';

    // Close outer constructor 0
    datum += 'ff';

    return datum;
  }

  /**
   * Remove liquidity from VyFi pool
   *
   * Sends LP tokens to the pool's order validator address with a remove liquidity datum.
   * VyFi will process the order and return tokenA (VT) + tokenB (ADA) to the specified return address.
   *
   * Requirements (from VyFi):
   * - Must send to pool's orderValidatorUtxoAddress
   * - Must include minimum 2 ADA + 1.9 ADA processor fee = 3.9 ADA total
   *
   * @param lpTokenUnit - Full unit of LP token (policyId + assetName)
   * @param lpAmount - Amount of LP tokens to remove
   * @param returnAddress - Address where VT + ADA should be returned (defaults to admin)
   * @param orderAddress - Pool's order validator address (defaults to configured pool address)
   * @param minTokenA - Minimum VT to receive (0 = no slippage protection)
   * @param minTokenB - Minimum ADA to receive (0 = no slippage protection)
   */
  async removeLiquidity({
    lpTokenUnit,
    lpAmount,
    returnAddress,
    orderAddress,
    minTokenA = 0,
    minTokenB = 0,
  }: {
    lpTokenUnit: string;
    lpAmount: number;
    returnAddress?: string;
    orderAddress?: string;
    minTokenA?: number;
    minTokenB?: number;
  }): Promise<{ txHash: string }> {
    const effectiveReturnAddress = returnAddress || this.adminAddress;
    const effectiveOrderAddress = orderAddress || this.poolAddress;

    this.logger.log(`Removing liquidity: ${lpAmount} LP tokens`);
    this.logger.log(`LP Token Unit: ${lpTokenUnit}`);
    this.logger.log(`Order Address: ${effectiveOrderAddress}`);
    this.logger.log(`Return Address: ${effectiveReturnAddress}`);

    // Parse LP token unit into policy ID and asset name
    const lpPolicyId = lpTokenUnit.slice(0, 56);
    const lpAssetName = lpTokenUnit.slice(56);

    // Get admin UTXOs containing LP tokens
    const { utxos: adminUtxos, requiredInputs } = await getUtxosExtract(
      Address.from_bech32(this.adminAddress),
      this.blockfrost,
      {
        targetAssets: [{ token: lpTokenUnit, amount: Number(lpAmount) }],
      }
    );

    if (adminUtxos.length === 0) {
      throw new Error(`No UTXOs found with LP tokens in admin wallet`);
    }

    // Build the remove liquidity datum
    const datumHex = this.buildRemoveLiquidityDatum(effectiveReturnAddress, minTokenA, minTokenB);
    this.logger.log(`Remove liquidity datum: ${datumHex}`);

    // Build the transaction
    // VyFi requires minimum 3.9 ADA (2 ADA min + 1.9 ADA processor fee) with LP tokens
    const input = {
      changeAddress: this.adminAddress,
      utxos: adminUtxos,
      outputs: [
        {
          address: effectiveOrderAddress,
          assets: [
            {
              assetName: { name: lpAssetName, format: 'hex' as const },
              policyId: lpPolicyId,
              quantity: lpAmount,
            },
          ],
          lovelace: VYFI_CONSTANTS.MIN_REMOVAL_LP_ADA, // 3.9 ADA required for LP removal
          datum: {
            type: 'inline' as const,
            value: datumHex,
          },
        },
      ],
      requiredSigners: [this.adminHash],
      requiredInputs,
      validityInterval: {
        start: true,
        end: true,
      },
      metadata: {
        [674]: 'VyFi: LP Remove Liquidity Order Request',
      },
      network: this.isMainnet ? 'mainnet' : 'preprod',
    };

    this.logger.debug(JSON.stringify(input));

    const buildResponse = await this.blockchainService.buildTransaction(input);
    this.logger.debug(JSON.stringify(buildResponse));

    const txToSubmit = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
    txToSubmit.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

    const submitResponse = await this.blockchainService.submitTransaction({
      transaction: txToSubmit.to_hex(),
      signatures: [],
    });

    this.logger.log(`Remove liquidity transaction submitted: ${submitResponse.txHash}`);

    return {
      txHash: submitResponse.txHash,
    };
  }

  /**
   * Remove liquidity for a vault by looking up pool info
   *
   * @param vaultId - The vault ID to remove liquidity for
   * @param minTokenA - Minimum VT to receive (optional)
   * @param minTokenB - Minimum ADA to receive (optional)
   */
  async removeLiquidityForVault(
    vaultId: string,
    minTokenA: number = 0,
    minTokenB: number = 0
  ): Promise<{
    txHash: string;
    lpAmount: string;
    poolInfo: any;
  }> {
    // Get the LP claim for this vault
    const lpClaim = await this.claimRepository.findOne({
      where: {
        vault: { id: vaultId },
        type: ClaimType.LP,
        status: ClaimStatus.CLAIMED,
      },
      relations: ['vault'],
    });

    if (!lpClaim) {
      throw new NotFoundException(`No claimed LP tokens found for vault ${vaultId}`);
    }

    // Get pool info by token pair
    const vtUnit = `${lpClaim.vault.script_hash}${lpClaim.vault.asset_vault_name}`;
    const poolInfo = await this.getPoolByTokens(vtUnit);

    if (!poolInfo) {
      throw new Error(`Pool not found for vault token ${vtUnit}`);
    }

    // Get LP token balance in admin wallet
    const adminUtxos = await this.blockfrost.addressesUtxos(this.adminAddress);
    let lpBalance = BigInt(0);

    for (const utxo of adminUtxos) {
      const lpAmount = utxo.amount.find(a => a.unit === poolInfo.lpTokenUnit);
      if (lpAmount) {
        lpBalance += BigInt(lpAmount.quantity);
      }
    }

    if (lpBalance === BigInt(0)) {
      throw new Error(`No LP tokens found in admin wallet for pool ${poolInfo.poolId}`);
    }

    this.logger.log(`Found ${lpBalance} LP tokens for vault ${vaultId}`);
    this.logger.log(`Pool order address: ${poolInfo.orderAddress}`);

    // Execute remove liquidity - use the pool's specific order address
    const result = await this.removeLiquidity({
      lpTokenUnit: poolInfo.lpTokenUnit,
      lpAmount: Number(lpBalance),
      returnAddress: this.adminAddress,
      orderAddress: poolInfo.orderAddress, // Use pool-specific order validator address
      minTokenA,
      minTokenB,
    });

    return {
      txHash: result.txHash,
      lpAmount: lpBalance.toString(),
      poolInfo,
    };
  }

  /**
   * Step 1: Withdraw ADA from dispatch script to admin address
   * Handles backend restart scenarios by checking for existing withdrawal transactions
   */
  async withdrawAdaFromDispatch(vaultId: string): Promise<{
    txHash: string | null;
    withdrawnAmount: number;
    skipped: boolean;
    reason?: string;
  }> {
    const claim = await this.claimRepository.findOne({
      where: { vault: { id: vaultId }, type: ClaimType.LP, status: ClaimStatus.AVAILABLE },
      relations: ['vault'],
    });

    if (!claim || !claim.vault?.dispatch_parametized_hash) {
      throw new NotFoundException('Vault or dispatch script not found');
    }

    // Check if withdrawal transaction already exists (backend restart scenario)
    const existingWithdrawal = await this.transactionRepository.findOne({
      where: {
        vault_id: vaultId,
        type: TransactionType.extractDispatch,
        status: TransactionStatus.confirmed,
        metadata: { purpose: 'lp_creation' } as any,
      },
      order: { created_at: 'DESC' },
    });

    if (existingWithdrawal) {
      this.logger.log(
        `Found existing withdrawal transaction ${existingWithdrawal.tx_hash} for vault ${vaultId}. ` +
          `Skipping withdrawal step (backend restart scenario).`
      );
      return {
        txHash: existingWithdrawal.tx_hash,
        withdrawnAmount: existingWithdrawal.metadata?.withdrawnAmount || 0,
        skipped: true,
        reason: 'existing_transaction',
      };
    }

    const DISPATCH_ADDRESS = getAddressFromHash(claim.vault.dispatch_parametized_hash, this.networkId);

    // Get dispatch UTXOs
    const dispatchUtxos = await this.blockfrost.addressesUtxos(DISPATCH_ADDRESS);

    // Check if dispatch is empty - this means withdrawal already happened or was never needed
    if (!dispatchUtxos || dispatchUtxos.length === 0) {
      this.logger.log(
        `No UTXOs found at dispatch address for vault ${vaultId}. ` +
          `Withdrawal already completed or not required. Skipping withdrawal step.`
      );
      return {
        txHash: null,
        withdrawnAmount: 0,
        skipped: true,
        reason: 'dispatch_empty',
      };
    }

    // Calculate total ADA to withdraw
    let totalDispatchAda = 0;
    const validDispatchUtxos: any[] = [];

    for (const utxo of dispatchUtxos) {
      const adaAmount = parseInt(utxo.amount.find(a => a.unit === 'lovelace')?.quantity || '0');
      if (adaAmount > 0) {
        totalDispatchAda += adaAmount;
        validDispatchUtxos.push(utxo);
      }
    }

    // If no ADA in dispatch UTXOs, skip withdrawal
    if (totalDispatchAda === 0) {
      this.logger.log(`No ADA available in dispatch script for vault ${vaultId}. ` + `Skipping withdrawal step.`);
      return {
        txHash: null,
        withdrawnAmount: 0,
        skipped: true,
        reason: 'no_ada',
      };
    }

    // Create transaction record before submission
    const withdrawalTx = await this.transactionRepository.save({
      vault_id: vaultId,
      type: TransactionType.extractDispatch,
      status: TransactionStatus.created,
      metadata: {
        purpose: 'lp_creation',
        withdrawnAmount: totalDispatchAda,
        dispatchAddress: DISPATCH_ADDRESS,
        adminAddress: this.adminAddress,
      },
    });

    this.logger.log(`Created withdrawal transaction record ${withdrawalTx.id} for vault ${vaultId}`);

    // Retry loop for spent admin UTXOs
    const MAX_UTXO_RETRIES = 3;
    let utxoRetryCount = 0;
    const excludedUtxos: Set<string> = new Set();

    while (utxoRetryCount <= MAX_UTXO_RETRIES) {
      try {
        // Get admin UTXOs for fees (pass excludeUtxoRefs to filter known spent UTXOs)
        const { utxos: adminUtxos } = await getUtxosExtract(Address.from_bech32(this.adminAddress), this.blockfrost, {
          minAda: 2_000_000,
          excludeUtxoRefs: excludedUtxos.size > 0 ? excludedUtxos : undefined,
        });

        if (excludedUtxos.size > 0) {
          this.logger.log(`Fetched admin UTXOs for withdrawal with ${excludedUtxos.size} excluded refs`);
        }

        if (adminUtxos.length === 0) {
          throw new Error('No valid admin UTXOs available after filtering spent UTXOs');
        }

        // Build withdrawal transaction
        const input = {
          changeAddress: this.adminAddress,
          message: 'Withdraw ADA from dispatch for LP creation',
          utxos: adminUtxos,
          preloadedScripts: [claim.vault.dispatch_preloaded_script.preloadedScript],
          scriptInteractions: [
            // Spend all dispatch UTXOs
            ...validDispatchUtxos.map(utxo => ({
              purpose: 'spend',
              hash: claim.vault.dispatch_parametized_hash,
              outputRef: {
                txHash: utxo.tx_hash,
                index: utxo.output_index,
              },
              redeemer: {
                type: 'json',
                value: null,
              },
            })),
            // Withdraw rewards
            {
              purpose: 'withdraw',
              hash: claim.vault.dispatch_parametized_hash,
              redeemer: {
                type: 'json',
                value: null,
              },
            },
          ],
          outputs: [
            // Send all ADA to admin address
            {
              address: this.adminAddress,
              lovelace: totalDispatchAda,
            },
          ],
          requiredSigners: [this.adminHash],
          referenceInputs: [
            {
              txHash: claim.vault.last_update_tx_hash,
              index: 0,
            },
          ],
          validityInterval: {
            start: true,
            end: true,
          },
          network: this.isMainnet ? 'mainnet' : 'preprod',
        };

        const buildResponse = await this.blockchainService.buildTransaction(input);
        const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
        txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

        const submitResponse = await this.blockchainService.submitTransaction({
          transaction: txToSubmitOnChain.to_hex(),
          signatures: [],
        });

        // Update transaction record with tx hash
        await this.transactionRepository.update(
          { id: withdrawalTx.id },
          {
            tx_hash: submitResponse.txHash,
            status: TransactionStatus.submitted,
          }
        );

        this.logger.log(
          `Successfully withdrew ${totalDispatchAda} lovelace from dispatch script. Tx: ${submitResponse.txHash}`
        );

        // Wait for confirmation
        await new Promise(resolve => setTimeout(resolve, 2000));
        const confirmed = await this.blockchainService.waitForTransactionConfirmation(submitResponse.txHash);

        if (confirmed) {
          await this.transactionRepository.update({ id: withdrawalTx.id }, { status: TransactionStatus.confirmed });
          this.logger.log(`Withdrawal transaction ${submitResponse.txHash} confirmed`);
        } else {
          this.logger.warn(`Withdrawal transaction ${submitResponse.txHash} not confirmed yet`);
        }

        return {
          txHash: submitResponse.txHash,
          withdrawnAmount: totalDispatchAda,
          skipped: false,
        };
      } catch (error) {
        // Check if this is a MissingUtxoException and we can retry
        if (error instanceof MissingUtxoException && error.fullTxHash && utxoRetryCount < MAX_UTXO_RETRIES) {
          const spentUtxoRef = error.getUtxoReference();
          this.logger.warn(
            `Detected spent admin UTXO in withdrawal: ${spentUtxoRef}, ` +
              `removing from pool and retrying (attempt ${utxoRetryCount + 1}/${MAX_UTXO_RETRIES})`
          );
          excludedUtxos.add(spentUtxoRef);
          utxoRetryCount++;

          // Small delay before retry
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }

        // Non-retryable error or max retries reached - update transaction as failed
        await this.transactionRepository.update(
          { id: withdrawalTx.id },
          {
            status: TransactionStatus.failed,
            metadata: {
              purpose: 'lp_creation',
              error: error.message,
              excludedUtxos: Array.from(excludedUtxos),
            } as any,
          }
        );

        throw error;
      }
    }

    // Should not reach here, but just in case
    throw new Error('Max UTXO retries exceeded for withdrawal');
  }

  /**
   * Step 2: Create VyFi liquidity pool using admin UTXOs only
   * (No script interactions, so admin address will be first input)
   */
  async createLiquidityPoolSimple(vaultId: string): Promise<{
    txHash: string;
  }> {
    const claim = await this.claimRepository.findOne({
      where: { vault: { id: vaultId }, type: ClaimType.LP, status: ClaimStatus.AVAILABLE },
      relations: ['vault'],
    });

    if (!claim) {
      throw new NotFoundException('Liquidity pool claim not found');
    }

    // Check if pool exists
    const poolCheck = await this.checkPool({
      networkId: this.networkId,
      tokenAUnit: `${claim.vault.script_hash}${claim.vault.asset_vault_name}`,
      tokenBUnit: 'lovelace',
    });

    if (poolCheck.exists) {
      throw new Error('Pool already exists');
    }

    // Calculate required ADA
    const requiredLpAda = Number(claim.lovelace_amount || 0);

    if (requiredLpAda < VYFI_CONSTANTS.MIN_POOL_ADA) {
      throw new Error(
        `Insufficient ADA for pool creation. Minimum required is ${VYFI_CONSTANTS.MIN_POOL_ADA} lovelace`
      );
    }

    // Generate metadata
    const metadataText = this.formatMetadataText(
      {
        policyId: claim.vault.script_hash,
        assetName: claim.vault.asset_vault_name,
      },
      claim.vault.vault_token_ticker
    );

    // Retry loop for spent admin UTXOs
    const MAX_UTXO_RETRIES = 3;
    let utxoRetryCount = 0;
    const excludedUtxos: Set<string> = new Set();

    while (utxoRetryCount <= MAX_UTXO_RETRIES) {
      try {
        // Get admin UTXOs (pass excludeUtxoRefs to filter known spent UTXOs)
        const { utxos: adminUtxos, requiredInputs } = await getUtxosExtract(
          Address.from_bech32(this.adminAddress),
          this.blockfrost,
          {
            targetAssets: [
              { token: `${claim.vault.script_hash}${claim.vault.asset_vault_name}`, amount: +claim.amount },
            ],
            excludeUtxoRefs: excludedUtxos.size > 0 ? excludedUtxos : undefined,
          }
        );

        if (excludedUtxos.size > 0) {
          this.logger.log(`Fetched admin UTXOs for LP creation with ${excludedUtxos.size} excluded refs`);
        }

        if (adminUtxos.length === 0) {
          throw new Error('No valid admin UTXOs available after filtering spent UTXOs');
        }

        const input = {
          changeAddress: this.adminAddress,
          message: metadataText,
          utxos: adminUtxos,
          outputs: [
            {
              address: this.poolAddress,
              assets: [
                {
                  assetName: { name: claim.vault.asset_vault_name, format: 'hex' },
                  policyId: claim.vault.script_hash,
                  quantity: +claim.amount,
                },
              ],
              lovelace: requiredLpAda,
            },
          ],
          metadata: {
            [674]: metadataText,
          },
          requiredSigners: [this.adminHash],
          requiredInputs,
          validityInterval: {
            start: true,
            end: true,
          },
          network: this.isMainnet ? 'mainnet' : 'preprod',
        };

        const buildResponse = await this.blockchainService.buildTransaction(input);
        const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
        txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

        const submitResponse = await this.blockchainService.submitTransaction({
          transaction: txToSubmitOnChain.to_hex(),
          signatures: [],
        });

        // Mark claim as claimed
        await this.claimRepository.update({ id: claim.id }, { status: ClaimStatus.CLAIMED });

        return {
          txHash: submitResponse.txHash,
        };
      } catch (error) {
        // Check if this is a MissingUtxoException and we can retry
        if (error instanceof MissingUtxoException && error.fullTxHash && utxoRetryCount < MAX_UTXO_RETRIES) {
          const spentUtxoRef = error.getUtxoReference();
          this.logger.warn(
            `Detected spent admin UTXO in LP creation: ${spentUtxoRef}, ` +
              `removing from pool and retrying (attempt ${utxoRetryCount + 1}/${MAX_UTXO_RETRIES})`
          );
          excludedUtxos.add(spentUtxoRef);
          utxoRetryCount++;

          // Small delay before retry
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }

        // Non-retryable error or max retries reached
        throw error;
      }
    }

    // Should not reach here, but just in case
    throw new Error('Max UTXO retries exceeded for LP creation');
  }

  /**
   * Combined flow: Withdraw then create LP
   */
  async createLiquidityPoolWithWithdrawal(vaultId: string): Promise<{
    withdrawalTxHash: string | null;
    lpCreationTxHash: string;
    withdrawalSkipped: boolean;
  }> {
    // Step 1: Withdraw ADA from dispatch
    const { txHash: withdrawalTxHash, skipped } = await this.withdrawAdaFromDispatch(vaultId);

    // Wait for withdrawal to confirm only if it happened
    if (!skipped && withdrawalTxHash) {
      this.logger.log('Waiting 90s for withdrawal confirmation before creating LP...');
      await new Promise(resolve => setTimeout(resolve, 90000));
    } else {
      this.logger.log('Withdrawal skipped, proceeding directly to LP creation');
    }

    // Step 2: Create LP using admin UTXOs only
    const { txHash: lpCreationTxHash } = await this.createLiquidityPoolSimple(vaultId);

    return {
      withdrawalTxHash,
      lpCreationTxHash,
      withdrawalSkipped: skipped,
    };
  }

  private formatMetadataText(tokenA: { policyId?: string; assetName: string }, ticker: string): string {
    const tokenAUnit = tokenA.policyId ? `${tokenA.policyId}.${tokenA.assetName}` : 'lovelace';
    return `L4VA: LP Factory Create Pool Order Request -- /${tokenAUnit} --- ADA/${ticker}`;
  }

  // Original TX with only creating LP
  // async createLiquidityPool(claimId: string): Promise<{
  //   txHash: string;
  // }> {
  //   const claim = await this.claimRepository.findOne({
  //     where: { id: claimId, type: ClaimType.LP, status: ClaimStatus.AVAILABLE },
  //     relations: ['vault'],
  //   });

  //   if (!claim) {
  //     throw new NotFoundException('Liquidity pool claim not found');
  //   }

  //   // First check if pool exists
  //   const poolCheck = await this.checkPool({
  //     networkId: 0,
  //     tokenAUnit: `${claim.vault.script_hash}${claim.vault.asset_vault_name}`,
  //     tokenBUnit: 'lovelace',
  //   });

  //   if (poolCheck.exists) {
  //     throw new Error('Pool already exists');
  //   }

  //   // Generate metadata
  //   const metadataText = this.formatMetadataText(
  //     {
  //       policyId: claim.vault.script_hash,
  //       assetName: claim.vault.asset_vault_name,
  //     },
  //     claim.vault.vault_token_ticker
  //   );

  //   // Get UTxOs
  //   const { utxos: adminUtxos, requiredInputs } = await getUtxosExtract(
  //     Address.from_bech32(this.adminAddress),
  //     this.blockfrost,
  //    {
  //      targetAssets: [{ token: `${claim.vault.script_hash}${claim.vault.asset_vault_name}`, amount: +claim.amount }],
  //    }
  //   );

  //   if (adminUtxos.length === 0) {
  //     throw new Error('No UTXOs found.');
  //   }

  //   // Construct transaction input with proper ADA amounts
  //   const input = {
  //     changeAddress: this.adminAddress,
  //     message: metadataText,
  //     utxos: adminUtxos,
  //     outputs: [
  //       {
  //         address: VYFI_CONSTANTS.POOL_ADDRESS,
  //         assets: [
  //           {
  //             assetName: { name: claim.vault.asset_vault_name, format: 'hex' },
  //             policyId: claim.vault.script_hash,
  //             quantity: +claim.amount,
  //           },
  //         ],
  //         lovelace: VYFI_CONSTANTS.TOTAL_REQUIRED_ADA + Number(claim.lovelace_amount || 0),
  //       },
  //     ],
  //     metadata: {
  //       [674]: metadataText,
  //     },
  //     requiredSigners: [this.adminHash],
  //     requiredInputs,
  //   };

  //   const buildResponse = await this.blockchainService.buildTransaction(input);
  //   const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
  //   txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

  //   // Submit the transaction
  //   const submitResponse = await this.blockchainService.submitTransaction({
  //     transaction: txToSubmitOnChain.to_hex(),
  //     signatures: [],
  //   });

  //   return {
  //     txHash: submitResponse.txHash,
  //   };
  // }

  /**
   * Create VyFi Liquidity Pool with Dispatch Withdrawal
   *
   * Currently doesn`t work, because first input is SC_ADDRESS, which Vyfi takes as address to send LP tokens
   * In future they will add logic to explicitly set return address for LP tokens
   *
   * This is the enhanced version that combines:
   * 1. Withdrawal of ADA from vault dispatch script
   * 2. Collection of vault tokens from admin address
   * 3. Creation of VyFi liquidity pool in single transaction
   *
   * Transaction Flow:
   * - Inputs: Admin UTXOs (vault tokens + fees) + Dispatch UTXOs (ADA)
   * - Outputs: VyFi pool (tokens + ADA) + Admin change
   *
   *
   * @param vaultId - ID of the vault to process
   * @returns Transaction hash of submitted LP creation
   * @throws NotFoundException if claim not found
   * @throws Error if pool already exists or insufficient funds
   *
   */
  // async createLiquidityPool(vaultId: string): Promise<{
  //   txHash: string;
  // }> {
  //   const claim = await this.claimRepository.findOne({
  //     where: { vault: { id: vaultId }, type: ClaimType.LP, status: ClaimStatus.AVAILABLE },
  //     relations: ['vault'],
  //   });

  //   if (!claim) {
  //     throw new NotFoundException('Liquidity pool claim not found');
  //   }

  //   // First check if pool exists
  //   const poolCheck = await this.checkPool({
  //     networkId: 0,
  //     tokenAUnit: `${claim.vault.script_hash}${claim.vault.asset_vault_name}`,
  //     tokenBUnit: 'lovelace',
  //   });

  //   if (poolCheck.exists) {
  //     throw new Error('Pool already exists');
  //   }

  //   if (!claim.vault?.dispatch_parametized_hash) {
  //     throw new Error('Vault does not have dispatch script configured');
  //   }

  //   const DISPATCH_ADDRESS = getAddressFromHash(claim.vault.dispatch_parametized_hash);
  //   // Get dispatch UTXOs to withdraw ADA from
  //   const dispatchUtxos = await this.blockfrost.addressesUtxos(DISPATCH_ADDRESS);
  //   if (!dispatchUtxos || dispatchUtxos.length === 0) {
  //     throw new Error('No UTXOs found at dispatch address');
  //   }

  //   // Calculate total available ADA from dispatch script
  //   let totalDispatchAda = 0;
  //   const validDispatchUtxos: any[] = [];

  //   for (const utxo of dispatchUtxos) {
  //     const adaAmount = parseInt(utxo.amount.find(a => a.unit === 'lovelace')?.quantity || '0');
  //     if (adaAmount > 0) {
  //       totalDispatchAda += adaAmount;
  //       validDispatchUtxos.push(utxo);
  //     }
  //   }

  //   // Calculate required ADA for LP creation
  //   const requiredLpAda = Number(claim.lovelace_amount || 0);

  //   if (totalDispatchAda < requiredLpAda) {
  //     throw new Error(
  //       `Insufficient ADA in dispatch script. Need ${requiredLpAda} lovelace, but only ${totalDispatchAda} available`
  //     );
  //   }

  //   // Generate metadata
  //   const metadataText = this.formatMetadataText(
  //     {
  //       policyId: claim.vault.script_hash,
  //       assetName: claim.vault.asset_vault_name,
  //     },
  //     claim.vault.vault_token_ticker
  //   );

  //   // Get admin UTXOs (for transaction fees and vault tokens)
  //   const { utxos: adminUtxos, requiredInputs } = await getUtxosExtract(
  //     Address.from_bech32(this.adminAddress),
  //     this.blockfrost,
  //    {
  //      targetAssets: [{ token: `${claim.vault.script_hash}${claim.vault.asset_vault_name}`, amount: +claim.amount }],
  //    }
  //   );

  //   if (adminUtxos.length === 0) {
  //     throw new Error('No admin UTXOs found.');
  //   }

  //   if (requiredLpAda < VYFI_CONSTANTS.MIN_POOL_ADA) {
  //   throw new Error(
  //     `Insufficient ADA for pool creation. Minimum required is ${VYFI_CONSTANTS.MIN_POOL_ADA} lovelace`
  //   );
  // }

  //   // Build combined transaction
  //   const input = {
  //     changeAddress: this.adminAddress,
  //     message: metadataText,
  //     utxos: adminUtxos,
  //     preloadedScripts: [claim.vault.dispatch_preloaded_script.preloadedScript],
  //     scriptInteractions: [
  //       // Withdraw from all dispatch UTXOs
  //       ...validDispatchUtxos.map(utxo => ({
  //         purpose: 'spend',
  //         hash: claim.vault.dispatch_parametized_hash,
  //         outputRef: {
  //           txHash: utxo.tx_hash,
  //           index: utxo.output_index,
  //         },
  //         redeemer: {
  //           type: 'json',
  //           value: null,
  //         },
  //       })),
  //       // Withdraw rewards from dispatch script
  //       {
  //         purpose: 'withdraw',
  //         hash: claim.vault.dispatch_parametized_hash,
  //         redeemer: {
  //           type: 'json',
  //           value: null,
  //         },
  //       },
  //     ],
  //     outputs: [
  //       // Send tokens + ADA to VyFi pool FROM ADMIN
  //       {
  //         address: VYFI_CONSTANTS.POOL_ADDRESS,
  //         assets: [
  //           {
  //             assetName: { name: claim.vault.asset_vault_name, format: 'hex' },
  //             policyId: claim.vault.script_hash,
  //             quantity: +claim.amount,
  //           },
  //         ],
  //         lovelace: requiredLpAda, // Use exact required amount
  //       },
  //       // If there's leftover ADA after LP creation, keep it in admin
  //       ...(totalDispatchAda > requiredLpAda
  //         ? [
  //             {
  //               address: this.adminAddress,
  //               lovelace: totalDispatchAda - requiredLpAda,
  //             },
  //           ]
  //         : []),
  //     ],
  //     metadata: {
  //       [674]: metadataText,
  //     },
  //     requiredSigners: [this.adminHash],
  //     requiredInputs, // For vault tokens from admin
  //     referenceInputs: [
  //       {
  //         txHash: claim.vault.last_update_tx_hash,
  //         index: 0,
  //       },
  //     ],
  //     validityInterval: {
  //       start: true,
  //       end: true,
  //     },
  //     network: this.isMainnet ? 'mainnet' : 'preprod',
  //   };

  //   const buildResponse = await this.blockchainService.buildTransaction(input);
  //   const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
  //   txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

  //   // Submit the transaction
  //   const submitResponse = await this.blockchainService.submitTransaction({
  //     transaction: txToSubmitOnChain.to_hex(),
  //     signatures: [],
  //   });

  //   await this.claimRepository.update({ id: claim.id }, { status: ClaimStatus.CLAIMED });

  //   return {
  //     txHash: submitResponse.txHash,
  //   };
  // }
}
