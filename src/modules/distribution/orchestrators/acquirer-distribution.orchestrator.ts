import { Buffer } from 'node:buffer';

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Address, FixedTransaction, PrivateKey } from '@emurgo/cardano-serialization-lib-nodejs';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AcquirerExtractionBuilder } from '../builders/acquirer-extraction.builder';

import { Claim } from '@/database/claim.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { AssetsService } from '@/modules/vaults/assets/assets.service';
import { ClaimsService } from '@/modules/vaults/claims/claims.service';
import { TransactionsService } from '@/modules/vaults/processing-tx/offchain-tx/transactions.service';
import { BlockchainService } from '@/modules/vaults/processing-tx/onchain/blockchain.service';
import { getTransactionSize, getUtxosExtract } from '@/modules/vaults/processing-tx/onchain/utils/lib';
import { ClaimStatus, ClaimType } from '@/types/claim.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

/**
 * Orchestrates acquirer extraction workflow
 * Handles batch processing, retries, and transaction confirmation
 */
@Injectable()
export class AcquirerDistributionOrchestrator {
  private readonly logger = new Logger(AcquirerDistributionOrchestrator.name);
  private readonly MAX_TX_SIZE = 15900;
  private readonly MAX_BATCH_SIZE = 30;

  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    private readonly blockchainService: BlockchainService,
    private readonly claimsService: ClaimsService,
    private readonly assetService: AssetsService,
    private readonly transactionService: TransactionsService,
    private readonly extractionBuilder: AcquirerExtractionBuilder,
    private readonly blockfrost: BlockFrostAPI
  ) {}

  /**
   * Process all acquirer extractions for a vault
   */
  async processAcquirerExtractions(
    vaultId: string,
    config: {
      adminAddress: string;
      adminHash: string;
      adminSKey: string;
      unparametizedDispatchHash: string;
    }
  ): Promise<void> {
    const vault = await this.vaultRepository
      .createQueryBuilder('vault')
      .select([
        'vault.id',
        'vault.script_hash',
        'vault.asset_vault_name',
        'vault.ada_pair_multiplier',
        'vault.last_update_tx_hash',
        'vault.dispatch_parametized_hash',
        'vault.dispatch_preloaded_script',
        'vault.tokens_for_acquires',
        'vault.stake_registered',
      ])
      .leftJoinAndSelect('vault.claims', 'claim', 'claim.type = :type AND claim.status = :status', {
        type: ClaimType.ACQUIRER,
        status: ClaimStatus.PENDING,
      })
      .leftJoinAndSelect('claim.transaction', 'transaction')
      .leftJoinAndSelect('claim.user', 'user')
      .where('vault.id = :vaultId', { vaultId })
      .getOne();

    if (!vault) {
      throw new Error(`Vault ${vaultId} not found`);
    }

    const claims = vault.claims || [];
    this.logger.log(`Found ${claims.length} acquirer claims to extract for vault ${vaultId}`);

    if (claims.length === 0) return;

    // Process in batches
    for (let i = 0; i < claims.length; i += this.MAX_BATCH_SIZE) {
      const batchClaims = claims.slice(i, i + this.MAX_BATCH_SIZE);
      await this.processAcquirerBatch(vault, batchClaims, vaultId, config);

      if (i + this.MAX_BATCH_SIZE < claims.length) {
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }
  }

  /**
   * Process a single batch of acquirer claims
   */
  private async processAcquirerBatch(
    vault: Vault,
    claims: Claim[],
    vaultId: string,
    config: {
      adminAddress: string;
      adminHash: string;
      adminSKey: string;
      unparametizedDispatchHash: string;
    }
  ): Promise<void> {
    // Create batch transaction record
    const extractionTx = await this.transactionRepository.save({
      vault_id: vaultId,
      user_id: null,
      type: TransactionType.extractDispatch,
      status: TransactionStatus.created,
    });

    this.logger.debug(`Processing batch extraction for ${claims.length} claims, transaction ${extractionTx.id}`);

    try {
      await this.executeBatchExtraction(vault, claims, extractionTx, config);
    } catch (error) {
      this.logger.warn(`Batch extraction failed for ${claims.length} claims: ${error.message}`);

      await this.transactionService.updateTransactionStatusById(extractionTx.id, TransactionStatus.failed);

      // If single claim, mark as failed
      if (claims.length === 1) {
        return;
      }

      // Split and retry
      await this.splitAndRetryBatch(vault, claims, vaultId, config);
    }
  }

  /**
   * Execute the actual batch extraction transaction
   */
  private async executeBatchExtraction(
    vault: Vault,
    claims: Claim[],
    extractionTx: Transaction,
    config: {
      adminAddress: string;
      adminHash: string;
      adminSKey: string;
      unparametizedDispatchHash: string;
    }
  ): Promise<void> {
    // Get admin UTXOs
    const { utxos: adminUtxos } = await getUtxosExtract(Address.from_bech32(config.adminAddress), this.blockfrost, {
      minAda: 4000000,
    });

    // Validate claims
    const { validClaims, invalidClaims } = await this.claimsService.validateClaimUtxos(claims);

    if (validClaims.length === 0) {
      this.logger.log(`No valid claims remaining after UTXO validation. Skipping batch.`);
      await this.transactionService.updateTransactionStatusById(extractionTx.id, TransactionStatus.failed);
      return;
    }

    if (invalidClaims.length > 0) {
      this.logger.warn(
        `Removed ${invalidClaims.length} invalid claims: ` +
          invalidClaims.map(ic => `${ic.claim.id} (${ic.reason})`).join(', ')
      );
    }

    // Check if this is the first extraction (will register stake)
    const isFirstExtraction = !vault.stake_registered;

    // Build transaction input
    const input = await this.extractionBuilder.buildExtractionInput(vault, validClaims, adminUtxos, config);

    // Build and validate transaction size
    const buildResponse = await this.blockchainService.buildTransaction(input);
    const actualTxSize = getTransactionSize(buildResponse.complete);

    this.logger.debug(`Transaction size: ${actualTxSize} bytes (${(actualTxSize / 1024).toFixed(2)} KB)`);

    if (actualTxSize > this.MAX_TX_SIZE) {
      throw new Error(`Transaction size ${actualTxSize} bytes exceeds Cardano limit of ${this.MAX_TX_SIZE} bytes`);
    }

    // Sign and submit
    const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
    txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(config.adminSKey));

    const response = await this.blockchainService.submitTransaction({
      transaction: txToSubmitOnChain.to_hex(),
    });

    await this.transactionService.updateTransactionHash(extractionTx.id, response.txHash);

    this.logger.log(`Batch extraction transaction ${response.txHash} submitted, waiting for confirmation...`);

    // Wait for confirmation
    const confirmed = await this.transactionService.waitForTransactionStatus(
      extractionTx.id,
      TransactionStatus.confirmed,
      120000
    );

    if (confirmed) {
      await this.claimsService.updateClaimStatus(
        validClaims.map(c => c.id),
        ClaimStatus.CLAIMED,
        { distributionTxId: extractionTx.id }
      );

      await this.assetService.markAssetsAsDistributedByTransactions(validClaims.map(c => c.transaction.id));
      await this.transactionService.updateTransactionStatusById(extractionTx.id, TransactionStatus.confirmed);

      if (isFirstExtraction) {
        await this.vaultRepository.update({ id: vault.id }, { stake_registered: true });
        this.logger.log(`Marked vault ${vault.id} stake as registered`);
      }

      this.logger.log(`Batch extraction transaction ${response.txHash} confirmed and processed`);
    } else {
      await this.transactionService.updateTransactionStatusById(extractionTx.id, TransactionStatus.failed);
      throw new Error(`Transaction ${response.txHash} failed to confirm within timeout period`);
    }
  }

  /**
   * Split batch in half and retry with smaller batches
   */
  private async splitAndRetryBatch(vault: Vault, claims: Claim[], vaultId: string, config: any): Promise<void> {
    const midPoint = Math.ceil(claims.length / 2);
    const firstHalf = claims.slice(0, midPoint);
    const secondHalf = claims.slice(midPoint);

    this.logger.log(`Splitting batch into two smaller batches: ${firstHalf.length} and ${secondHalf.length} claims`);

    await this.processAcquirerBatch(vault, firstHalf, vaultId, config);
    await new Promise(resolve => setTimeout(resolve, 5000));
    await this.processAcquirerBatch(vault, secondHalf, vaultId, config);
  }
}
