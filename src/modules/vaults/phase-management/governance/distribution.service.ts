import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Address, FixedTransaction } from '@emurgo/cardano-serialization-lib-nodejs';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import {
  DistributionBatch,
  DistributionBatchStatus,
  DistributionInfo,
  DistributionMetadata,
  DistributionRecipient,
} from './dto/distribution.dto';

import { Claim } from '@/database/claim.entity';
import { Proposal } from '@/database/proposal.entity';
import { Snapshot } from '@/database/snapshot.entity';
import { Transaction } from '@/database/transaction.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { BlockchainService } from '@/modules/vaults/processing-tx/onchain/blockchain.service';
import { getUtxosExtract } from '@/modules/vaults/processing-tx/onchain/utils/lib';
import { TreasuryWalletService } from '@/modules/vaults/treasure/treasure-wallet.service';
import { DistributionClaimMetadata } from '@/types/claim-metadata.types';
import { ClaimStatus, ClaimType } from '@/types/claim.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

export type DistributionStatus = 'pending' | 'in_progress' | 'completed' | 'partially_failed' | 'failed';

@Injectable()
export class DistributionService {
  private readonly logger = new Logger(DistributionService.name);
  private readonly isMainnet: boolean;
  private readonly blockfrost: BlockFrostAPI;

  // Configuration constants
  private readonly MIN_ADA_PER_RECIPIENT = 2_000_000; // 2 ADA minimum per recipient (covers min UTXO)
  private readonly MAX_RECIPIENTS_PER_BATCH = 40; // Safe limit for transaction size (~16KB)
  private readonly MAX_RETRY_ATTEMPTS = 3;
  private readonly BATCH_RETRY_DELAY_MS = 60_000; // 1 minute between retries
  private readonly FEE_RESERVE_PER_BATCH = 2_000_000; // 2 ADA buffer per batch (tx fees + min UTxO + safety margin)

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Claim)
    private readonly claimRepository: Repository<Claim>,
    @InjectRepository(Snapshot)
    private readonly snapshotRepository: Repository<Snapshot>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Proposal)
    private readonly proposalRepository: Repository<Proposal>,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService,
    private readonly treasuryWalletService: TreasuryWalletService,
    private readonly eventEmitter: EventEmitter2
  ) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';

    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });
  }

  /**
   * Get distribution info for UI - shows treasury balance and VT holder count
   */
  async getDistributionInfo(vaultId: string): Promise<DistributionInfo> {
    const warnings: string[] = [];

    // Check if vault has treasury wallet
    const treasuryWallet = await this.treasuryWalletService.getTreasuryWallet(vaultId);

    if (!treasuryWallet) {
      return {
        treasuryBalance: { lovelace: 0, lovelaceFormatted: '0' },
        vtHolderCount: 0,
        minDistributableAda: 0,
        maxDistributableAda: 0,
        minAdaPerHolder: this.MIN_ADA_PER_RECIPIENT / 1_000_000,
        hasTreasuryWallet: false,
        warnings: ['No treasury wallet found for this vault'],
      };
    }

    // Get treasury balance - handle case where wallet exists but has never received ADA
    let balance: { lovelace: number; assets: any[] };
    try {
      balance = await this.treasuryWalletService.getTreasuryWalletBalance(vaultId);
    } catch (error) {
      // Blockfrost returns 404 "not found" for addresses that have never received any ADA
      // This means the wallet exists but has no UTXOs yet
      this.logger.warn(
        `Treasury wallet ${treasuryWallet.address} has no UTXOs yet (never received ADA): ${error.message}`
      );

      return {
        treasuryBalance: { lovelace: 0, lovelaceFormatted: '0.000000' },
        vtHolderCount: 0,
        minDistributableAda: 0,
        maxDistributableAda: 0,
        minAdaPerHolder: this.MIN_ADA_PER_RECIPIENT / 1_000_000,
        hasTreasuryWallet: true, // Wallet exists, just empty
        warnings: [],
      };
    }

    const lovelaceFormatted = (balance.lovelace / 1_000_000).toFixed(6);

    // Get latest snapshot for VT holders
    const snapshot = await this.snapshotRepository.findOne({
      where: { vaultId },
      order: { createdAt: 'DESC' },
    });

    if (!snapshot || !snapshot.addressBalances) {
      warnings.push('No snapshot available. Create a proposal to generate a new snapshot.');
      return {
        treasuryBalance: { lovelace: balance.lovelace, lovelaceFormatted },
        vtHolderCount: 0,
        minDistributableAda: 0,
        maxDistributableAda: balance.lovelace / 1_000_000,
        minAdaPerHolder: this.MIN_ADA_PER_RECIPIENT / 1_000_000,
        hasTreasuryWallet: true,
        warnings,
      };
    }

    const vtHolderCount = Object.values(snapshot.addressBalances).length;

    if (vtHolderCount === 0) {
      warnings.push('No VT holders found in the latest snapshot');
    }

    // Calculate minimum ADA needed to distribute to all holders
    const minDistributableLovelace = BigInt(vtHolderCount) * BigInt(this.MIN_ADA_PER_RECIPIENT);
    const minDistributableAda = Number(minDistributableLovelace) / 1_000_000;

    // Calculate fee reserve based on estimated batch count
    const estimatedBatches = Math.ceil(vtHolderCount / this.MAX_RECIPIENTS_PER_BATCH);
    const totalFeeReserve = estimatedBatches * this.FEE_RESERVE_PER_BATCH;
    const maxDistributableLovelace = Math.max(0, balance.lovelace - totalFeeReserve);
    const maxDistributableAda = maxDistributableLovelace / 1_000_000;

    // Check if treasury has enough for minimum distribution
    if (balance.lovelace < Number(minDistributableLovelace) && vtHolderCount > 0) {
      warnings.push(
        `Treasury balance (${lovelaceFormatted} ADA) is insufficient for minimum distribution. ` +
          `Need at least ${minDistributableAda.toFixed(2)} ADA (${this.MIN_ADA_PER_RECIPIENT / 1_000_000} ADA × ${vtHolderCount} holders)`
      );
    }

    // Add warning if trying to distribute close to full balance
    if (vtHolderCount > 0 && totalFeeReserve > 0) {
      warnings.push(
        `Transaction fees: ~${(totalFeeReserve / 1_000_000).toFixed(2)} ADA reserved for ${estimatedBatches} batch${estimatedBatches > 1 ? 'es' : ''}`
      );
    }

    return {
      treasuryBalance: { lovelace: balance.lovelace, lovelaceFormatted },
      vtHolderCount,
      minDistributableAda,
      maxDistributableAda,
      minAdaPerHolder: this.MIN_ADA_PER_RECIPIENT / 1_000_000,
      hasTreasuryWallet: true,
      warnings,
    };
  }

  /**
   * Validate distribution proposal parameters
   */
  async validateDistribution(
    vaultId: string,
    lovelaceAmount: string
  ): Promise<{
    valid: boolean;
    errors: string[];
    warnings: string[];
    recipientCount?: number;
    lovelacePerHolder?: string;
  }> {
    const errors: string[] = [];
    const warnings: string[] = [];

    const amount = BigInt(lovelaceAmount);

    // Get distribution info
    const info = await this.getDistributionInfo(vaultId);

    if (!info.hasTreasuryWallet) {
      errors.push('No treasury wallet available for this vault');
      return { valid: false, errors, warnings };
    }

    if (info.vtHolderCount === 0) {
      errors.push('No VT holders found. Cannot create distribution proposal.');
      return { valid: false, errors, warnings };
    }

    // Check if amount exceeds max distributable (treasury balance minus fee reserve)
    const maxDistributableLovelace = BigInt(Math.floor(info.maxDistributableAda * 1_000_000));
    if (amount > maxDistributableLovelace) {
      errors.push(
        `Distribution amount (${Number(amount) / 1_000_000} ADA) exceeds max distributable (${info.maxDistributableAda.toFixed(6)} ADA). ` +
          `Treasury balance is ${info.treasuryBalance.lovelaceFormatted} ADA minus fee reserve.`
      );
    }

    // Calculate per-holder amount (average)
    const lovelacePerHolder = amount / BigInt(info.vtHolderCount);

    // Check if some holders will be skipped due to minimum requirement
    // This is a warning, not an error - we allow distribution even if some holders get less than minimum
    // Those holders will simply be skipped during execution
    if (lovelacePerHolder < BigInt(this.MIN_ADA_PER_RECIPIENT)) {
      // Estimate how many holders will actually receive distribution
      // This is approximate - actual calculation happens during execution based on VT proportions
      const estimatedEligibleHolders = Math.floor(Number(amount) / this.MIN_ADA_PER_RECIPIENT);
      const skippedHolders = Math.max(0, info.vtHolderCount - estimatedEligibleHolders);

      if (estimatedEligibleHolders === 0) {
        errors.push(
          `Distribution amount too small. No holder would receive the minimum ${this.MIN_ADA_PER_RECIPIENT / 1_000_000} ADA. ` +
            `Need at least ${this.MIN_ADA_PER_RECIPIENT / 1_000_000} ADA total.`
        );
      } else {
        warnings.push(
          `Some holders (~${skippedHolders}) may not receive distribution due to minimum ${this.MIN_ADA_PER_RECIPIENT / 1_000_000} ADA requirement. ` +
            `Only holders whose proportional share is >= ${this.MIN_ADA_PER_RECIPIENT / 1_000_000} ADA will receive funds.`
        );
      }
    }

    // Add warning for large number of holders (many batches)
    const estimatedBatches = Math.ceil(info.vtHolderCount / this.MAX_RECIPIENTS_PER_BATCH);
    if (estimatedBatches > 10) {
      warnings.push(
        `Distribution will require ${estimatedBatches} batch transactions due to ${info.vtHolderCount} holders. ` +
          `This may take some time to complete.`
      );
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      recipientCount: info.vtHolderCount,
      lovelacePerHolder: lovelacePerHolder.toString(),
    };
  }

  /**
   * Execute distribution proposal - creates claims and processes batches
   */
  async executeDistribution(proposal: Proposal): Promise<boolean> {
    if (!proposal.snapshotId) {
      throw new Error(
        `CRITICAL BUG: proposal.snapshotId is undefined for proposal ${proposal.id}. This usually means snapshotId was not selected when loading the proposal.`
      );
    }

    const vault = await this.vaultRepository.findOne({
      where: { id: proposal.vaultId },
    });

    if (!vault) {
      throw new Error(`Vault ${proposal.vaultId} not found`);
    }

    const snapshot = await this.snapshotRepository.findOne({
      where: { id: proposal.snapshotId },
    });

    if (!snapshot || !snapshot.addressBalances) {
      throw new Error(`Snapshot not found for proposal ${proposal.id}`);
    }

    // Get distribution amount from proposal metadata
    const lovelaceAmountStr = proposal.metadata?.distributionLovelaceAmount;

    if (!lovelaceAmountStr) {
      throw new Error('No distribution amount found in proposal metadata');
    }

    const totalLovelace = BigInt(lovelaceAmountStr);

    // Get treasury wallet
    const treasuryWallet = await this.treasuryWalletService.getTreasuryWallet(vault.id);

    if (!treasuryWallet) {
      throw new Error(`No treasury wallet found for vault ${vault.id}`);
    }

    // Calculate distribution amounts for each holder
    const recipients = await this.calculateDistributionAmounts(snapshot.addressBalances, totalLovelace);

    if (recipients.length === 0) {
      throw new Error('No valid recipients for distribution');
    }

    // Create claims for all recipients
    const claims = await this.createDistributionClaims(vault, proposal, recipients);

    // Split into batches
    const batches = this.createBatches(claims, proposal.id);

    // Initialize distribution metadata (simplified - doesn't store redundant data)
    const distributionMetadata: DistributionMetadata = {
      totalLovelaceToDistribute: totalLovelace.toString(),
      totalRecipients: recipients.length,
      lovelacePerHolder: (totalLovelace / BigInt(recipients.length)).toString(),
      minLovelacePerHolder: Math.min(...recipients.map(r => Number(r.lovelaceShare))).toString(),
      batches,
      completedBatches: 0,
      failedBatches: 0,
    };

    // Store initial metadata in proposal
    proposal.metadata = {
      ...proposal.metadata,
      distribution: distributionMetadata,
    };
    await this.proposalRepository.save(proposal);

    // Process all batches
    let allSuccess = true;
    for (const batch of batches) {
      const success = await this.processBatch(proposal, batch, treasuryWallet.address);

      if (!success) {
        allSuccess = false;
        // Continue with other batches, failed ones will be retried
      }

      // Small delay between batches to allow chain propagation
      if (batches.indexOf(batch) < batches.length - 1) {
        await this.delay(5000);
      }
    }

    // Update final status
    const updatedMetadata = proposal.metadata.distribution as DistributionMetadata;

    await this.proposalRepository.save(proposal);

    this.eventEmitter.emit('proposal.distribution.executed', {
      proposalId: proposal.id,
      vaultId: vault.id,
      totalDistributed: totalLovelace.toString(),
      recipientCount: recipients.length,
      batchCount: batches.length,
      completedBatches: updatedMetadata.completedBatches,
      failedBatches: updatedMetadata.failedBatches,
      network: this.isMainnet ? 'mainnet' : 'testnet',
    });

    return allSuccess;
  }

  /**
   * Retry failed distribution batches for a proposal
   */
  async retryFailedBatches(proposalId: string): Promise<{
    retriedCount: number;
    successCount: number;
    stillFailedCount: number;
  }> {
    const proposal = await this.proposalRepository.findOne({
      where: { id: proposalId },
      relations: ['vault'],
    });

    if (!proposal || !proposal.metadata?.distribution) {
      throw new Error(`Distribution proposal ${proposalId} not found or has no distribution metadata`);
    }

    // Get treasury wallet address for the vault
    const treasuryWallet = await this.treasuryWalletService.getTreasuryWallet(proposal.vaultId);
    if (!treasuryWallet) {
      throw new Error(`No treasury wallet found for vault ${proposal.vaultId}`);
    }

    const distribution = proposal.metadata.distribution as DistributionMetadata;
    const failedBatches = distribution.batches.filter(
      b => b.status === DistributionBatchStatus.FAILED && b.retryCount < this.MAX_RETRY_ATTEMPTS
    );

    if (failedBatches.length === 0) {
      return { retriedCount: 0, successCount: 0, stillFailedCount: 0 };
    }

    let successCount = 0;
    let stillFailedCount = 0;

    for (const batch of failedBatches) {
      const success = await this.processBatch(proposal, batch, treasuryWallet.address);

      if (success) {
        successCount++;
      } else {
        stillFailedCount++;
      }

      // Delay between retries
      await this.delay(this.BATCH_RETRY_DELAY_MS);
    }

    return {
      retriedCount: failedBatches.length,
      successCount,
      stillFailedCount,
    };
  }

  /**
   * Calculate distribution amounts for each VT holder based on their holdings
   */
  private async calculateDistributionAmounts(
    addressBalances: Record<string, string>,
    totalLovelace: bigint
  ): Promise<DistributionRecipient[]> {
    const recipients: DistributionRecipient[] = [];

    // Calculate total VT supply
    const totalVtSupply = Object.values(addressBalances).reduce((sum, balance) => sum + BigInt(balance), BigInt(0));

    if (totalVtSupply === BigInt(0)) {
      return recipients;
    }

    const eligibleAddresses: { address: string; vtBalance: bigint; lovelaceShare: bigint }[] = [];

    for (const [address, balance] of Object.entries(addressBalances)) {
      const vtBalance = BigInt(balance);

      if (vtBalance === BigInt(0)) continue;

      const lovelaceShare = (totalLovelace * vtBalance) / totalVtSupply;

      if (lovelaceShare < BigInt(this.MIN_ADA_PER_RECIPIENT)) {
        this.logger.warn(
          `Skipping address ${address} - share ${lovelaceShare} below minimum ${this.MIN_ADA_PER_RECIPIENT}`
        );
        continue;
      }

      eligibleAddresses.push({ address, vtBalance, lovelaceShare });
    }

    if (eligibleAddresses.length === 0) {
      return recipients;
    }

    const addresses = eligibleAddresses.map(e => e.address);
    const users = await this.userRepository.find({
      where: { address: In(addresses) },
      select: ['id', 'address'],
    });

    const addressToUserIdMap = new Map(users.map(u => [u.address, u.id]));

    for (const { address, vtBalance, lovelaceShare } of eligibleAddresses) {
      recipients.push({
        address,
        vtBalance,
        lovelaceShare,
        userId: addressToUserIdMap.get(address),
      });
    }

    return recipients;
  }

  /**
   * Create distribution claims for all recipients
   */
  private async createDistributionClaims(
    vault: Vault,
    proposal: Proposal,
    recipients: DistributionRecipient[]
  ): Promise<Claim[]> {
    const claims: Partial<Claim>[] = [];

    for (const recipient of recipients) {
      const metadata: DistributionClaimMetadata = {
        address: recipient.address,
      };

      claims.push({
        user_id: recipient.userId,
        proposal_id: proposal.id,
        vault,
        type: ClaimType.DISTRIBUTION,
        status: ClaimStatus.PENDING, // Will be updated to AVAILABLE after successful tx
        amount: 0, // Not used for distribution claims
        lovelace_amount: Number(recipient.lovelaceShare),
        description: `Distribution of ${Number(recipient.lovelaceShare) / 1_000_000} ADA from proposal "${proposal.title}"`,
        metadata,
      });
    }

    // Bulk save claims
    const savedClaims = await this.claimRepository.save(claims);

    this.logger.log(`Created ${savedClaims.length} distribution claims for proposal ${proposal.id}`);

    return savedClaims as Claim[];
  }

  /**
   * Split claims into batches for transaction processing
   */
  private createBatches(claims: Claim[], proposalId: string): DistributionBatch[] {
    const batches: DistributionBatch[] = [];
    const totalBatches = Math.ceil(claims.length / this.MAX_RECIPIENTS_PER_BATCH);

    for (let i = 0; i < totalBatches; i++) {
      const batchClaims = claims.slice(i * this.MAX_RECIPIENTS_PER_BATCH, (i + 1) * this.MAX_RECIPIENTS_PER_BATCH);

      const totalLovelace = batchClaims.reduce((sum, c) => sum + BigInt(c.lovelace_amount || 0), BigInt(0));

      batches.push({
        batchId: `${proposalId}-batch-${i + 1}`,
        batchNumber: i + 1,
        totalBatches,
        recipientCount: batchClaims.length,
        lovelaceAmount: totalLovelace.toString(),
        status: DistributionBatchStatus.PENDING,
        claimIds: batchClaims.map(c => c.id),
        retryCount: 0,
      });
    }

    return batches;
  }

  /**
   * Process a single distribution batch
   * Creates a Transaction entity to track the tx hash
   */
  private async processBatch(proposal: Proposal, batch: DistributionBatch, treasuryAddress: string): Promise<boolean> {
    const distribution = proposal.metadata.distribution as DistributionMetadata;

    // Update batch status to processing
    batch.status = DistributionBatchStatus.PROCESSING;
    batch.lastAttempt = new Date().toISOString();
    await this.proposalRepository.save(proposal);

    this.logger.log(
      `Processing batch ${batch.batchNumber}/${batch.totalBatches} with ${batch.recipientCount} recipients`
    );

    try {
      // Get claims for this batch
      const claims = await this.claimRepository.find({
        where: { id: In(batch.claimIds) },
      });

      if (claims.length === 0) {
        throw new Error(`No claims found for batch ${batch.batchId}`);
      }

      // Build and submit the distribution transaction
      const txHash = await this.buildAndSubmitDistributionTx(treasuryAddress, proposal.vaultId, claims);

      // Create transaction record
      // Convert lovelace to ADA for the amount field (must be integer if column is bigint)
      const amountInAda = Math.floor(Number(batch.lovelaceAmount) / 1_000_000);
      const transaction = await this.transactionRepository.save({
        type: TransactionType.distribution,
        status: TransactionStatus.submitted,
        vault_id: proposal.vaultId,
        tx_hash: txHash,
        amount: amountInAda,
        metadata: {
          batchId: batch.batchId,
          recipientCount: claims.length,
          lovelaceAmount: batch.lovelaceAmount, // Store exact lovelace amount in metadata
        },
      });

      // Update claims with transaction reference
      for (let i = 0; i < claims.length; i++) {
        const claim = claims[i];
        claim.status = ClaimStatus.CLAIMED;
        claim.distribution_tx_id = transaction.id;
        const currentMetadata = claim.metadata as DistributionClaimMetadata;
        claim.metadata = {
          address: currentMetadata.address,
          batchId: batch.batchId,
        };
      }
      await this.claimRepository.save(claims);

      // Update batch status with transaction reference
      batch.status = DistributionBatchStatus.COMPLETED;
      batch.transactionId = transaction.id;
      distribution.completedBatches++;
      await this.proposalRepository.save(proposal);

      this.logger.log(`Batch ${batch.batchNumber} completed successfully: ${txHash}`);

      return true;
    } catch (error) {
      this.logger.error(`Batch ${batch.batchNumber} failed: ${error.message}`, error.stack);

      batch.retryCount++;
      batch.error = error.message;

      if (batch.retryCount >= this.MAX_RETRY_ATTEMPTS) {
        batch.status = DistributionBatchStatus.FAILED;
        distribution.failedBatches++;

        // Mark claims as failed
        await this.claimRepository.update(batch.claimIds, {
          status: ClaimStatus.FAILED,
        });
      } else {
        batch.status = DistributionBatchStatus.RETRY_PENDING;
      }

      await this.proposalRepository.save(proposal);

      return false;
    }
  }

  /**
   * Build and submit the distribution transaction
   */
  private async buildAndSubmitDistributionTx(
    treasuryAddress: string,
    vaultId: string,
    claims: Claim[]
  ): Promise<string> {
    // Get treasury wallet keys
    const { privateKey: treasuryPrivateKey, stakePrivateKey: treasuryStakeKey } =
      await this.treasuryWalletService.getTreasuryWalletPrivateKey(vaultId);
    const treasuryPubKeyHash = treasuryPrivateKey.to_public().hash().to_hex();

    const { utxos: treasuryUtxos } = await getUtxosExtract(Address.from_bech32(treasuryAddress), this.blockfrost, {
      validateUtxos: false,
    });

    const outputs = claims.map(claim => {
      // Get recipient address from metadata (supports addresses not in users table)
      const metadata = claim.metadata as DistributionClaimMetadata;
      const recipientAddress = metadata?.address;

      if (!recipientAddress) {
        throw new Error(`No recipient address found in metadata for claim ${claim.id}`);
      }

      return {
        address: recipientAddress,
        lovelace: claim.lovelace_amount.toString(),
      };
    });

    // Build transaction input
    const txInput = {
      changeAddress: treasuryAddress, // Change goes back to treasury
      utxos: treasuryUtxos,
      message: `Distribution for vault ${vaultId}`,
      outputs,
      requiredSigners: [treasuryPubKeyHash],
      validityInterval: {
        start: true,
        end: true,
      },
      network: this.configService.get<string>('CARDANO_NETWORK'),
    };

    // Build transaction
    const buildResponse = await this.blockchainService.buildTransaction(txInput);

    // Sign with both treasury and admin keys
    const txToSubmit = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
    txToSubmit.sign_and_add_vkey_signature(treasuryPrivateKey);
    txToSubmit.sign_and_add_vkey_signature(treasuryStakeKey);

    // Submit transaction
    const submitResponse = await this.blockchainService.submitTransaction({
      transaction: txToSubmit.to_hex(),
    });

    return submitResponse.txHash;
  }

  /**
   * Get distribution status for a proposal
   * Returns batch details including txHash fetched from Transaction entity
   */
  async getDistributionStatus(proposalId: string): Promise<{
    status: DistributionStatus;
    totalBatches: number;
    completedBatches: number;
    failedBatches: number;
    pendingRetry: number;
    totalDistributed: string;
    batches: Array<DistributionBatch & { txHash?: string }>;
  }> {
    const proposal = await this.proposalRepository.findOne({
      where: { id: proposalId },
    });

    if (!proposal?.metadata?.distribution) {
      return {
        status: 'pending',
        totalBatches: 0,
        completedBatches: 0,
        failedBatches: 0,
        pendingRetry: 0,
        totalDistributed: '0',
        batches: [],
      };
    }

    const distribution = proposal.metadata.distribution as DistributionMetadata;
    const pendingRetry = distribution.batches.filter(b => b.status === DistributionBatchStatus.RETRY_PENDING).length;

    let status: DistributionStatus;

    if (distribution.completedBatches === distribution.batches.length) {
      status = 'completed';
    } else if (distribution.failedBatches === distribution.batches.length) {
      status = 'failed';
    } else if (distribution.failedBatches > 0) {
      status = 'partially_failed';
    } else if (distribution.completedBatches > 0 || pendingRetry > 0) {
      status = 'in_progress';
    } else {
      status = 'pending';
    }

    // Calculate total actually distributed
    const totalDistributed = distribution.batches
      .filter(b => b.status === DistributionBatchStatus.COMPLETED)
      .reduce((sum, b) => sum + BigInt(b.lovelaceAmount), BigInt(0));

    // Fetch transaction hashes for completed batches
    const transactionIds = distribution.batches.filter(b => b.transactionId).map(b => b.transactionId as string);

    const transactions =
      transactionIds.length > 0
        ? await this.transactionRepository.find({
            where: { id: In(transactionIds) },
            select: ['id', 'tx_hash'],
          })
        : [];

    const txHashMap = new Map(transactions.map(t => [t.id, t.tx_hash]));

    // Enrich batches with txHash from transactions
    const enrichedBatches = distribution.batches.map(batch => ({
      ...batch,
      txHash: batch.transactionId ? txHashMap.get(batch.transactionId) : undefined,
    }));

    return {
      status,
      totalBatches: distribution.batches.length,
      completedBatches: distribution.completedBatches,
      failedBatches: distribution.failedBatches,
      pendingRetry,
      totalDistributed: totalDistributed.toString(),
      batches: enrichedBatches,
    };
  }

  /**
   * Helper to add delay between operations
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
