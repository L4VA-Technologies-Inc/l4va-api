import { Buffer } from 'node:buffer';

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import {
  Address,
  FixedTransaction,
  PrivateKey,
  TransactionUnspentOutput,
} from '@emurgo/cardano-serialization-lib-nodejs';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';

import { ContributorPaymentBuilder } from '../builders/contributor-payment.builder';
import { AddressesUtxo, BatchSizeResult } from '../distribution.types';

import { Claim } from '@/database/claim.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { ClaimsService } from '@/modules/vaults/claims/claims.service';
import { TransactionsService } from '@/modules/vaults/processing-tx/offchain-tx/transactions.service';
import { BlockchainService } from '@/modules/vaults/processing-tx/onchain/blockchain.service';
import { MissingUtxoException } from '@/modules/vaults/processing-tx/onchain/exceptions/utxo-missing.exception';
import {
  getAddressFromHash,
  getTransactionSize,
  getUtxosExtract,
} from '@/modules/vaults/processing-tx/onchain/utils/lib';
import { ClaimStatus, ClaimType } from '@/types/claim.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

/**
 * Orchestrates contributor payment workflow
 * Handles batch size determination, payment processing, and confirmation
 */
@Injectable()
export class ContributorDistributionOrchestrator {
  private readonly logger = new Logger(ContributorDistributionOrchestrator.name);
  private readonly MAX_TX_SIZE = 15900;
  private readonly MAX_BATCH_SIZE = 15;

  constructor(
    @InjectRepository(Claim)
    private readonly claimRepository: Repository<Claim>,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    private readonly blockchainService: BlockchainService,
    private readonly transactionService: TransactionsService,
    private readonly claimsService: ClaimsService,
    private readonly paymentBuilder: ContributorPaymentBuilder,
    private readonly blockfrost: BlockFrostAPI
  ) {}

  /**
   * Process all contributor payments for a vault
   */
  async processContributorPayments(
    vaultId: string,
    vault: Vault,
    config: {
      adminAddress: string;
      adminHash: string;
      adminSKey: string;
      unparametizedDispatchHash: string;
    }
  ): Promise<void> {
    this.logger.log(`Starting contributor payment processing for vault ${vaultId}`);

    const readyClaims = await this.claimRepository.find({
      where: {
        vault: { id: vaultId },
        type: ClaimType.CONTRIBUTOR,
        status: ClaimStatus.PENDING,
      },
      relations: ['user', 'transaction'],
    });

    if (readyClaims.length === 0) {
      this.logger.log(`No ready contributor claims for vault ${vaultId}`);
      return;
    }

    this.logger.log(`Found ${readyClaims.length} contributor claims to process`);

    // Get dispatch UTXOs only if vault has tokens for acquirers
    const hasDispatchFunding = Number(vault.tokens_for_acquires) > 0;
    let dispatchUtxos: AddressesUtxo[] = [];

    if (hasDispatchFunding) {
      const DISPATCH_ADDRESS = getAddressFromHash(
        vault.dispatch_parametized_hash,
        this.blockchainService.getNetworkId()
      );
      try {
        dispatchUtxos = await this.blockfrost.addressesUtxos(DISPATCH_ADDRESS);

        if (!dispatchUtxos || dispatchUtxos.length === 0) {
          throw new Error(`No UTXOs found at dispatch address for vault ${vaultId}`);
        }
      } catch (error) {
        this.logger.error(`Failed to fetch dispatch UTXOs for vault ${vaultId}:`, error);
        throw error;
      }
    } else {
      this.logger.log(
        `Vault ${vaultId} has 0% for acquirers. No dispatch funding required, processing vault token minting only.`
      );
    }

    // Process claims with dynamic batching
    await this.processBatchedClaims(vault, readyClaims, dispatchUtxos, config);
  }

  /**
   * Process claims in optimal batches
   */
  private async processBatchedClaims(
    vault: Vault,
    claims: Claim[],
    dispatchUtxos: AddressesUtxo[],
    config: any
  ): Promise<void> {
    let processedCount = 0;
    let batchNumber = 0;

    while (processedCount < claims.length) {
      batchNumber++;

      try {
        const remainingClaims = claims.slice(processedCount);

        // Determine optimal batch size
        const { optimalBatchSize, actualClaims } = await this.determineOptimalBatchSize(
          vault,
          remainingClaims,
          dispatchUtxos,
          config
        );

        this.logger.log(
          `Processing payment batch ${batchNumber} with ${optimalBatchSize} claims ` +
            `(${processedCount + 1}-${processedCount + optimalBatchSize} of ${claims.length})`
        );

        // Process the batch
        await this.processBatchedPayments(vault, actualClaims, dispatchUtxos, config);

        processedCount += optimalBatchSize;

        // Delay between batches
        if (processedCount < claims.length) {
          this.logger.debug('Waiting 1s before next batch');
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (error) {
        this.logger.error(`Failed to process payment batch ${batchNumber}:`, error);

        const failedClaim = claims[processedCount];

        // Retry single claim
        this.logger.log(`Retrying single claim ${failedClaim.id} as batch of 1`);

        try {
          await this.processBatchedPayments(vault, [failedClaim], dispatchUtxos, config);
          processedCount += 1;
        } catch (singleError) {
          this.logger.error(`Failed to process single claim ${failedClaim.id}:`, singleError);
          processedCount += 1;
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    this.logger.log(`Completed processing ${processedCount} contributor payments for vault ${vault.id}`);
  }

  /**
   * Determine optimal batch size by testing transaction builds
   */
  private async determineOptimalBatchSize(
    vault: Vault,
    claims: Claim[],
    dispatchUtxos: AddressesUtxo[],
    config: any
  ): Promise<BatchSizeResult> {
    let testBatchSize = 2;
    let lastSuccessfulSize = 2;
    let lastSuccessfulClaims = claims.slice(0, 2);

    // Get admin UTXOs once for testing
    const { utxos: adminUtxos } = await getUtxosExtract(Address.from_bech32(config.adminAddress), this.blockfrost, {
      minAda: 4_000_000,
    });

    // Test increasing batch sizes
    while (testBatchSize <= Math.min(this.MAX_BATCH_SIZE, claims.length)) {
      const testClaims = claims.slice(0, testBatchSize);

      try {
        this.logger.debug(`Testing batch size ${testBatchSize}...`);

        const input = await this.paymentBuilder.buildPaymentInput(vault, testClaims, adminUtxos, dispatchUtxos, config);

        const buildResponse = await this.blockchainService.buildTransaction(input);
        const txSize = getTransactionSize(buildResponse.complete);

        this.logger.debug(`Batch size ${testBatchSize}: ${txSize} bytes (${(txSize / 1024).toFixed(2)} KB)`);

        if (txSize > this.MAX_TX_SIZE) {
          this.logger.log(
            `Batch size ${testBatchSize} produces ${txSize} bytes, exceeds target. ` +
              `Using ${lastSuccessfulSize} claims per batch.`
          );
          break;
        }

        lastSuccessfulSize = testBatchSize;
        lastSuccessfulClaims = testClaims;

        if (testBatchSize >= this.MAX_BATCH_SIZE) {
          this.logger.log(`Reached max batch size of ${this.MAX_BATCH_SIZE}`);
          break;
        }

        testBatchSize++;
      } catch (error) {
        this.logger.warn(`Batch size ${testBatchSize} failed to build: ${error.message}`);
        break;
      }
    }

    this.logger.log(
      `Optimal batch size determined: ${lastSuccessfulSize} claims ` + `(tested up to ${testBatchSize - 1})`
    );

    return {
      optimalBatchSize: lastSuccessfulSize,
      actualClaims: lastSuccessfulClaims,
    };
  }

  /**
   * Process a batch of payments in a single transaction
   * Includes retry logic for spent UTXOs
   */
  private async processBatchedPayments(
    vault: Vault,
    claims: Claim[],
    dispatchUtxos: AddressesUtxo[],
    config: {
      adminAddress: string;
      adminHash: string;
      adminSKey: string;
      unparametizedDispatchHash: string;
    }
  ): Promise<void> {
    this.logger.log(`Building batched payment transaction for ${claims.length} claims`);

    // Validate claims
    const { validClaims, invalidClaims } = await this.claimsService.validateClaimUtxos(claims);

    if (validClaims.length === 0) {
      this.logger.warn(`No valid claims remaining after UTXO validation for contributor payments`);
      throw new Error('All contributor claims have invalid UTXOs');
    }

    if (invalidClaims.length > 0) {
      this.logger.warn(
        `Removed ${invalidClaims.length} invalid contributor claims: ` +
          invalidClaims.map(ic => `${ic.claim.id} (${ic.reason})`).join(', ')
      );
    }

    // Create batch transaction record
    const batchTransaction = await this.transactionRepository.save({
      vault_id: vault.id,
      user_id: null,
      type: TransactionType.claim,
      status: TransactionStatus.created,
      metadata: {
        claimIds: validClaims.map(c => c.id),
      },
    });

    const MAX_UTXO_RETRIES = 3;
    let utxoRetryCount = 0;
    const excludedUtxos: Set<string> = new Set();

    while (utxoRetryCount <= MAX_UTXO_RETRIES) {
      try {
        // Get admin UTXOs
        let { utxos: adminUtxos } = await getUtxosExtract(Address.from_bech32(config.adminAddress), this.blockfrost, {
          minAda: 4_000_000,
        });

        // Filter out any previously identified spent UTXOs
        if (excludedUtxos.size > 0) {
          const originalCount = adminUtxos.length;
          adminUtxos = adminUtxos.filter(utxoHex => {
            // Parse the UTXO to get its reference
            const utxoRef = this.extractUtxoReference(utxoHex);
            const isExcluded = excludedUtxos.has(utxoRef);
            if (isExcluded) {
              this.logger.debug(`Excluding spent UTXO: ${utxoRef}`);
            }
            return !isExcluded;
          });
          this.logger.log(
            `Filtered admin UTXOs: ${originalCount} -> ${adminUtxos.length} (excluded ${excludedUtxos.size} spent)`
          );
        }

        if (adminUtxos.length === 0) {
          throw new Error('No valid admin UTXOs available after filtering spent UTXOs');
        }

        // Build transaction
        const input = await this.paymentBuilder.buildPaymentInput(
          vault,
          validClaims,
          adminUtxos,
          dispatchUtxos,
          config
        );

        const buildResponse = await this.blockchainService.buildTransaction(input);
        const txSize = getTransactionSize(buildResponse.complete);

        this.logger.log(`Batch payment transaction built: ${txSize} bytes (${(txSize / 1024).toFixed(2)} KB)`);

        if (txSize > this.MAX_TX_SIZE) {
          throw new Error(
            `Transaction size ${txSize} exceeds limit of ${this.MAX_TX_SIZE}, ` +
              `this should not happen after batch size determination`
          );
        }

        await new Promise(resolve => setTimeout(resolve, 1000));

        // Sign and submit
        const txToSubmit = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
        txToSubmit.sign_and_add_vkey_signature(PrivateKey.from_bech32(config.adminSKey));

        const response = await this.blockchainService.submitTransaction({
          transaction: txToSubmit.to_hex(),
          signatures: [],
        });

        this.logger.log(`Batch payment transaction submitted: ${response.txHash}`);

        await this.transactionRepository.update(
          { id: batchTransaction.id },
          { tx_hash: response.txHash, status: TransactionStatus.submitted }
        );

        // Wait for confirmation
        const confirmed = await this.transactionService.waitForTransactionStatus(
          batchTransaction.id,
          TransactionStatus.confirmed,
          120000
        );

        if (!confirmed) {
          throw new Error(`Batch payment transaction ${response.txHash} failed to confirm`);
        }

        // Update claims and transaction
        await this.claimsService.updateClaimStatus(
          validClaims.map(c => c.id),
          ClaimStatus.CLAIMED,
          { distributionTxId: batchTransaction.id }
        );
        await this.transactionRepository.update({ id: batchTransaction.id }, { status: TransactionStatus.confirmed });

        this.logger.log(
          `Successfully processed batch payment for ${validClaims.length} claims ` + `with tx: ${response.txHash}`
        );

        // Success - exit the retry loop
        return;
      } catch (error) {
        // Check if this is a MissingUtxoException and we can retry
        if (error instanceof MissingUtxoException && error.fullTxHash && utxoRetryCount < MAX_UTXO_RETRIES) {
          const spentUtxoRef = error.getUtxoReference();
          this.logger.warn(
            `Detected spent admin UTXO: ${spentUtxoRef}, ` +
              `removing from pool and retrying (attempt ${utxoRetryCount + 1}/${MAX_UTXO_RETRIES})`
          );
          excludedUtxos.add(spentUtxoRef);
          utxoRetryCount++;

          // Small delay before retry
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }

        // Non-retryable error or max retries reached
        this.logger.error(`Failed to process batched payments:`, error);

        await this.transactionRepository.update(
          { id: batchTransaction.id },
          {
            status: TransactionStatus.failed,
            metadata: {
              error: error.message,
              excludedUtxos: Array.from(excludedUtxos),
            },
          }
        );

        throw error;
      }
    }
  }

  /**
   * Extract UTXO reference (txHash#index) from hex-encoded UTXO
   */
  private extractUtxoReference(utxoHex: string): string {
    try {
      const utxo = TransactionUnspentOutput.from_hex(utxoHex);
      const input = utxo.input();
      const txHash = input.transaction_id().to_hex();
      const index = input.index();
      return `${txHash}#${index}`;
    } catch {
      // If we can't parse, return empty string (won't match anything)
      return '';
    }
  }

  /**
   * Check if all contributor payments are complete
   */
  async arePaymentsComplete(vaultId: string): Promise<boolean> {
    const remainingClaims = await this.claimRepository.count({
      where: {
        vault: { id: vaultId },
        type: ClaimType.CONTRIBUTOR,
        status: In([ClaimStatus.PENDING, ClaimStatus.FAILED]),
      },
    });

    return remainingClaims === 0;
  }
}
