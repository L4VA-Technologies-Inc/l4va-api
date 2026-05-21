import { Buffer } from 'node:buffer';

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Address, FixedTransaction, PrivateKey } from '@emurgo/cardano-serialization-lib-nodejs';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AcquireOnlyExtractionBuilder } from '../builders/acquire-only-extraction.builder';

import { Claim } from '@/database/claim.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { ClaimsService } from '@/modules/vaults/claims/claims.service';
import { GovernanceService } from '@/modules/vaults/phase-management/governance/governance.service';
import { TransactionsService } from '@/modules/vaults/processing-tx/offchain-tx/transactions.service';
import { BlockchainService } from '@/modules/vaults/processing-tx/onchain/blockchain.service';
import { getTransactionSize, getUtxosExtract } from '@/modules/vaults/processing-tx/onchain/utils/lib';
import { ClaimStatus, ClaimType } from '@/types/claim.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

/**
 * Orchestrates acquirer extraction for acquire-only vaults.
 *
 * Differences from AcquirerDistributionOrchestrator:
 *  - Uses AcquireOnlyExtractionBuilder (ADA → treasury, no stake deposit)
 *  - No dispatch parameterization
 *  - Marks distribution_processed = true after all batches complete
 */
@Injectable()
export class AcquireOnlyDistributionOrchestrator {
  private readonly logger = new Logger(AcquireOnlyDistributionOrchestrator.name);
  private readonly MAX_TX_SIZE = 16384;
  private readonly MAX_BATCH_SIZE = 16;

  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    private readonly blockchainService: BlockchainService,
    private readonly claimsService: ClaimsService,
    private readonly transactionService: TransactionsService,
    private readonly extractionBuilder: AcquireOnlyExtractionBuilder,
    private readonly blockfrost: BlockFrostAPI,
    private readonly governanceService: GovernanceService
  ) {}

  /**
   * Process all acquirer claims for an acquire-only vault.
   * After all batches succeed, marks distribution_processed = true.
   */
  async processAcquireOnlyExtractions(
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
        'vault.manual_distribution_mode',
      ])
      .leftJoinAndSelect('vault.treasury_wallet', 'treasury_wallet')
      .where('vault.id = :vaultId', { vaultId })
      .getOne();

    if (!vault) {
      throw new Error(`Vault ${vaultId} not found`);
    }

    if (vault.manual_distribution_mode) {
      this.logger.log(`Skipping acquire-only vault ${vaultId} - manual distribution mode enabled.`);
      return;
    }

    const treasuryAddress = vault.treasury_wallet?.treasury_address;
    if (!treasuryAddress) {
      this.logger.error(`Acquire-only vault ${vaultId} has no treasury wallet address. Cannot distribute.`);
      return;
    }

    const vaultWithClaims = await this.vaultRepository
      .createQueryBuilder('vault')
      .leftJoinAndSelect('vault.claims', 'claim', 'claim.type = :type AND claim.status = :status', {
        type: ClaimType.ACQUIRER,
        status: ClaimStatus.PENDING,
      })
      .leftJoinAndSelect('claim.transaction', 'transaction')
      .leftJoinAndSelect('claim.user', 'user')
      .where('vault.id = :vaultId', { vaultId })
      .getOne();

    const claims = vaultWithClaims?.claims || [];

    this.logger.log(`Found ${claims.length} acquire-only claims to extract for vault ${vaultId}`);

    if (claims.length === 0) {
      // Nothing to extract — mark distribution done
      await this.vaultRepository.update({ id: vaultId }, { distribution_processed: true });
      return;
    }

    const enrichedConfig = {
      ...config,
      treasuryAddress,
    };

    for (let i = 0; i < claims.length; i += this.MAX_BATCH_SIZE) {
      const batchClaims = claims.slice(i, i + this.MAX_BATCH_SIZE);
      await this.processAcquireOnlyBatch(vault, batchClaims, vaultId, enrichedConfig);

      if (i + this.MAX_BATCH_SIZE < claims.length) {
        await new Promise(resolve => setTimeout(resolve, 20000));
      }
    }

    // All batches processed — mark distribution complete
    await this.vaultRepository.update({ id: vaultId }, { distribution_processed: true });
    this.logger.log(`Acquire-only vault ${vaultId} distribution complete.`);

    // Create governance snapshot
    try {
      await this.governanceService.createAutomaticSnapshot(vaultId, `${vault.script_hash}${vault.asset_vault_name}`);
    } catch (error) {
      this.logger.error(`Error creating governance snapshot for vault ${vaultId}:`, error);
    }
  }

  private async processAcquireOnlyBatch(
    vault: Pick<Vault, 'id' | 'script_hash' | 'asset_vault_name' | 'ada_pair_multiplier' | 'last_update_tx_hash'>,
    claims: Claim[],
    vaultId: string,
    config: {
      adminAddress: string;
      adminHash: string;
      adminSKey: string;
      unparametizedDispatchHash: string;
      treasuryAddress: string;
    }
  ): Promise<void> {
    const extractionTx = await this.transactionRepository.save({
      vault_id: vaultId,
      user_id: null,
      type: TransactionType.extractDispatch,
      status: TransactionStatus.created,
      metadata: {
        claimIds: claims.map(c => c.id),
        transactionIds: claims.map(c => c.transaction.id),
        acquireOnly: true,
      },
    });

    this.logger.debug(`Acquire-only: processing batch of ${claims.length} claims, tx ${extractionTx.id}`);

    try {
      await this.executeAcquireOnlyBatchExtraction(vault, claims, extractionTx, config);
    } catch (error) {
      this.logger.warn(`Acquire-only batch extraction failed for ${claims.length} claims: ${error.message}`);
      await this.transactionService.updateTransactionStatusById(extractionTx.id, TransactionStatus.failed);

      if (claims.length === 1) return;

      const isMissingUtxoError =
        error.message?.toLowerCase().includes('missing utxo') ||
        error.message?.toLowerCase().includes("doesn't exist or has already been spent");

      if (isMissingUtxoError) {
        this.logger.warn(`Skipping batch split - missing/spent UTxO error for vault ${vaultId}`);
        return;
      }

      await this.splitAndRetryBatch(vault, claims, vaultId, config);
    }
  }

  private async executeAcquireOnlyBatchExtraction(
    vault: Pick<Vault, 'id' | 'script_hash' | 'asset_vault_name' | 'ada_pair_multiplier' | 'last_update_tx_hash'>,
    claims: Claim[],
    extractionTx: Transaction,
    config: {
      adminAddress: string;
      adminHash: string;
      adminSKey: string;
      unparametizedDispatchHash: string;
      treasuryAddress: string;
    }
  ): Promise<void> {
    const { utxos: adminUtxos } = await getUtxosExtract(Address.from_bech32(config.adminAddress), this.blockfrost, {
      minAda: 4000000,
    });

    const { validClaims, invalidClaims } = await this.claimsService.validateClaimUtxos(claims);

    if (validClaims.length === 0) {
      this.logger.log(`No valid claims remaining after UTXO validation for acquire-only vault. Skipping batch.`);
      await this.transactionService.updateTransactionStatusById(extractionTx.id, TransactionStatus.failed);
      return;
    }

    if (invalidClaims.length > 0) {
      this.logger.warn(
        `Removed ${invalidClaims.length} invalid claims: ` +
          invalidClaims.map(ic => `${ic.claim.id} (${ic.reason})`).join(', ')
      );
    }

    const input = await this.extractionBuilder.buildExtractionInput(vault, validClaims, adminUtxos, config);
    const buildResponse = await this.blockchainService.buildTransaction(input);
    const actualTxSize = getTransactionSize(buildResponse.complete);

    this.logger.debug(`Acquire-only tx size: ${actualTxSize} bytes (${(actualTxSize / 1024).toFixed(2)} KB)`);

    if (actualTxSize > this.MAX_TX_SIZE) {
      throw new Error(`Transaction size ${actualTxSize} bytes exceeds Cardano limit of ${this.MAX_TX_SIZE} bytes`);
    }

    const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
    txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(config.adminSKey));

    const response = await this.blockchainService.submitTransaction({
      transaction: txToSubmitOnChain.to_hex(),
    });

    await this.transactionService.updateTransactionHash(extractionTx.id, response.txHash);

    this.logger.log(`Acquire-only extraction tx ${response.txHash} submitted, waiting for confirmation...`);

    const confirmed = await this.transactionService.waitForTransactionStatus(
      extractionTx.id,
      TransactionStatus.confirmed,
      300000,
      5000,
      true
    );

    if (confirmed) {
      this.logger.log(`Acquire-only extraction tx ${response.txHash} confirmed`);
    } else {
      throw new Error(`Transaction ${response.txHash} failed to confirm within timeout period`);
    }
  }

  private async splitAndRetryBatch(
    vault: Pick<Vault, 'id' | 'script_hash' | 'asset_vault_name' | 'ada_pair_multiplier' | 'last_update_tx_hash'>,
    claims: Claim[],
    vaultId: string,
    config: any
  ): Promise<void> {
    const midPoint = Math.ceil(claims.length / 2);
    const firstHalf = claims.slice(0, midPoint);
    const secondHalf = claims.slice(midPoint);

    this.logger.log(`Splitting acquire-only batch into ${firstHalf.length} and ${secondHalf.length} claims`);

    await this.processAcquireOnlyBatch(vault, firstHalf, vaultId, config);
    await new Promise(resolve => setTimeout(resolve, 15000));
    await this.processAcquireOnlyBatch(vault, secondHalf, vaultId, config);
  }
}
