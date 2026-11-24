import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Address, FixedTransaction } from '@emurgo/cardano-serialization-lib-nodejs';
import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';

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
import { AlertsService } from '@/modules/alerts/alerts.service';
import { BlockchainService } from '@/modules/vaults/processing-tx/onchain/blockchain.service';
import { UtxoSpentException } from '@/modules/vaults/processing-tx/onchain/exceptions/utxo-spent.exception';
import { getUtxosExtract } from '@/modules/vaults/processing-tx/onchain/utils/lib';
import { TreasuryWalletService } from '@/modules/vaults/treasure/treasure-wallet.service';
import { DistributionClaimMetadata } from '@/types/claim-metadata.types';
import { ClaimStatus, ClaimType } from '@/types/claim.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

export type DistributionStatus = 'pending' | 'in_progress' | 'completed' | 'partially_failed' | 'failed';

/** Batches that still need work: never sent, rejected and queued, or sent with an unconfirmed outcome. */
/** See `DistributionMetadata.planVersion`. */
const DISTRIBUTION_PLAN_VERSION = 2;

export const UNFINISHED_BATCH_STATUSES: DistributionBatchStatus[] = [
  DistributionBatchStatus.PENDING,
  DistributionBatchStatus.PROCESSING,
  DistributionBatchStatus.RETRY_PENDING,
];

@Injectable()
export class DistributionService {
  private readonly logger = new Logger(DistributionService.name);
  private readonly isMainnet: boolean;
  private readonly blockfrost: BlockFrostAPI;

  // Configuration constants
  private readonly MIN_ADA_PER_RECIPIENT = 2_000_000; // 2 ADA minimum per recipient (covers min UTXO)
  private readonly MAX_RECIPIENTS_PER_BATCH = 200; // Cardano tx limit: 200-250 outputs fit in 16KB (research: 217 outputs = 14KB)
  private readonly MAX_RETRY_ATTEMPTS = 3;
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
    private readonly eventEmitter: EventEmitter2,
    private readonly alertsService: AlertsService
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
   * Execute a distribution proposal: create one claim per recipient, split them
   * into batches and pay each batch from the vault treasury.
   *
   * Never pays twice. The first call persists the claims and the batch plan in
   * one DB transaction; every later call (retry cron, a crash mid-way, an error
   * after some batches were paid) RESUMES that plan instead of building a new
   * one. Already-paid batches are skipped, and a batch whose submission outcome
   * is unknown is settled from chain, not rebuilt (see {@link runBatches}).
   *
   * The caller must hold the proposal's execution lock
   * (`GovernanceExecutionService.withExecutionLock`) so two runs never work the
   * same plan at once.
   *
   * @returns true when every batch is completed.
   */
  async executeDistribution(proposal: Proposal): Promise<boolean> {
    const vault = await this.vaultRepository.findOne({
      where: { id: proposal.vaultId },
    });

    if (!vault) {
      throw new Error(`Vault ${proposal.vaultId} not found`);
    }

    // Get treasury wallet
    const treasuryWallet = await this.treasuryWalletService.getTreasuryWallet(vault.id);

    if (!treasuryWallet) {
      throw new Error(`No treasury wallet found for vault ${vault.id}`);
    }

    // The plan in the DB is the authority on whether this distribution has
    // started, not the (possibly older) object we were handed.
    const fresh = await this.proposalRepository.findOne({ where: { id: proposal.id }, select: ['id', 'metadata'] });
    if (fresh?.metadata) proposal.metadata = fresh.metadata;

    const existing = proposal.metadata?.distribution as DistributionMetadata | undefined;
    if (existing?.batches?.length) {
      this.logger.warn(
        `Proposal ${proposal.id}: distribution already started (${existing.batches.length} batch(es)). ` +
          `Resuming the existing plan; no new claims are created.`
      );
      return this.runBatches(proposal, vault.id, treasuryWallet.address);
    }

    if (!proposal.snapshotId) {
      throw new Error(
        `CRITICAL BUG: proposal.snapshotId is undefined for proposal ${proposal.id}. This usually means snapshotId was not selected when loading the proposal.`
      );
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

    // Calculate distribution amounts for each holder
    const recipients = await this.calculateDistributionAmounts(snapshot.addressBalances, totalLovelace);

    if (recipients.length === 0) {
      throw new Error('No valid recipients for distribution');
    }

    // Claims and the batch plan are written together: a plan without its claims
    // (or claims without a plan) would make the next run start over.
    const distributionMetadata = await this.claimRepository.manager.transaction(async manager => {
      const claims = await this.createDistributionClaims(manager, vault, proposal, recipients);
      const batches = this.createBatches(claims, proposal.id);

      const metadata: DistributionMetadata = {
        planVersion: DISTRIBUTION_PLAN_VERSION,
        totalLovelaceToDistribute: totalLovelace.toString(),
        totalRecipients: recipients.length,
        lovelacePerHolder: (totalLovelace / BigInt(recipients.length)).toString(),
        minLovelacePerHolder: Math.min(...recipients.map(r => Number(r.lovelaceShare))).toString(),
        batches,
        completedBatches: 0,
        failedBatches: 0,
      };

      proposal.metadata = { ...proposal.metadata, distribution: metadata };
      await manager.getRepository(Proposal).update({ id: proposal.id }, { metadata: proposal.metadata });
      return metadata;
    });

    const allCompleted = await this.runBatches(proposal, vault.id, treasuryWallet.address);

    this.eventEmitter.emit('proposal.distribution.executed', {
      proposalId: proposal.id,
      vaultId: vault.id,
      totalDistributed: totalLovelace.toString(),
      recipientCount: recipients.length,
      batchCount: distributionMetadata.batches.length,
      completedBatches: distributionMetadata.completedBatches,
      failedBatches: distributionMetadata.failedBatches,
      network: this.isMainnet ? 'mainnet' : 'testnet',
    });

    return allCompleted;
  }

  /**
   * Resume the batches of a distribution that are not finished yet: settle the
   * ones whose submission outcome is unknown, then send the ones that were never
   * sent or that the node definitively rejected.
   *
   * The caller must hold the proposal's execution lock (the retry cron does).
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
    const unfinished = new Set(
      distribution.batches.filter(b => UNFINISHED_BATCH_STATUSES.includes(b.status)).map(b => b.batchId)
    );
    if (unfinished.size === 0) {
      return { retriedCount: 0, successCount: 0, stillFailedCount: 0 };
    }

    await this.runBatches(proposal, proposal.vaultId, treasuryWallet.address);

    const successCount = distribution.batches.filter(
      b => unfinished.has(b.batchId) && b.status === DistributionBatchStatus.COMPLETED
    ).length;

    return {
      retriedCount: unfinished.size,
      successCount,
      stillFailedCount: unfinished.size - successCount,
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
    manager: EntityManager,
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
        amount: '0', // Not used for distribution claims
        lovelace_amount: String(recipient.lovelaceShare),
        description: `Distribution of ${Number(recipient.lovelaceShare) / 1_000_000} ADA from proposal "${proposal.title}"`,
        metadata,
      });
    }

    // Bulk save claims
    const savedClaims = await manager.getRepository(Claim).save(claims);

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
   * Work every unfinished batch of `proposal.metadata.distribution` once.
   *
   *   PROCESSING            → submission outcome unknown: settle it from chain ({@link reconcileInFlightBatch})
   *   PENDING/RETRY_PENDING → never sent, or rejected by the node: build and send ({@link processBatch})
   *   COMPLETED/FAILED      → left alone
   *
   * @returns true when every batch is completed.
   */
  private async runBatches(proposal: Proposal, vaultId: string, treasuryAddress: string): Promise<boolean> {
    const distribution = proposal.metadata.distribution as DistributionMetadata;

    // A plan written by the old code may have batches that were submitted
    // without their tx being recorded; resuming it could pay them twice.
    if (distribution.planVersion !== DISTRIBUTION_PLAN_VERSION) {
      const unfinished = distribution.batches.filter(b => UNFINISHED_BATCH_STATUSES.includes(b.status));
      if (unfinished.length > 0) {
        this.logger.error(
          `Proposal ${proposal.id}: legacy distribution plan with ${unfinished.length} unfinished batch(es). ` +
            `Not resuming automatically; check the treasury's transactions and settle these batches by hand.`
        );
        await this.alertsService.sendAlert('distribution_legacy_plan_unfinished', {
          proposalId: proposal.id,
          vaultId,
          batches: unfinished.map(b => `${b.batchId}:${b.status}`).join(', '),
        });
      }
      return distribution.batches.every(b => b.status === DistributionBatchStatus.COMPLETED);
    }

    for (const batch of distribution.batches.filter(b => b.status === DistributionBatchStatus.PROCESSING)) {
      await this.reconcileInFlightBatch(proposal, vaultId, batch);
    }

    const toSend = distribution.batches.filter(
      b => b.status === DistributionBatchStatus.PENDING || b.status === DistributionBatchStatus.RETRY_PENDING
    );
    for (let i = 0; i < toSend.length; i++) {
      await this.processBatch(proposal, toSend[i], treasuryAddress);

      // Small delay between batches to allow chain propagation
      if (i < toSend.length - 1) {
        await this.delay(5000);
      }
    }

    return distribution.batches.every(b => b.status === DistributionBatchStatus.COMPLETED);
  }

  /**
   * Build, sign and send one batch.
   *
   * Invariant that makes retries safe: a batch is never submitted before its
   * `txHash` and `signedTx` are persisted. So a batch found in PROCESSING
   * without a `txHash` was never sent, and one with a `txHash` may be on chain
   * and is only ever settled from chain or resubmitted as the same signed tx.
   */
  private async processBatch(proposal: Proposal, batch: DistributionBatch, treasuryAddress: string): Promise<boolean> {
    batch.status = DistributionBatchStatus.PROCESSING;
    batch.lastAttempt = new Date().toISOString();
    batch.txHash = undefined;
    batch.signedTx = undefined;
    await this.saveDistribution(proposal);

    this.logger.log(
      `Processing batch ${batch.batchNumber}/${batch.totalBatches} with ${batch.recipientCount} recipients`
    );

    let signed: { txHash: string; signedTx: string };
    try {
      const claims = await this.claimRepository.find({
        where: { id: In(batch.claimIds) },
      });

      if (claims.length === 0) {
        throw new Error(`No claims found for batch ${batch.batchId}`);
      }

      signed = await this.buildSignedDistributionTx(treasuryAddress, proposal.vaultId, claims);

      batch.txHash = signed.txHash;
      batch.signedTx = signed.signedTx;
      await this.saveDistribution(proposal);
    } catch (error) {
      // Nothing has been submitted yet.
      this.logger.error(`Batch ${batch.batchNumber} failed before submission: ${error.message}`, error.stack);
      await this.markRejected(proposal, batch, error);
      return false;
    }

    try {
      await this.blockchainService.submitTransaction({ transaction: signed.signedTx });
    } catch (error) {
      if (error instanceof HttpException) {
        // The node refused this freshly built tx, so it is not on chain and a
        // rebuilt one cannot double-pay.
        this.logger.error(`Batch ${batch.batchNumber} rejected by the node: ${error.message}`);
        await this.markRejected(proposal, batch, error);
        return false;
      }

      // Timeout, 5xx or an unrecognised error: the tx may have reached the
      // node. Leave it PROCESSING with its hash; the next run settles it from
      // chain instead of building a second payment.
      batch.error = `Submission outcome unknown, will be checked on chain: ${error.message}`;
      await this.saveDistribution(proposal);
      this.logger.error(
        `Batch ${batch.batchNumber} submission outcome unknown (tx ${signed.txHash}): ${error.message}`,
        error.stack
      );
      return false;
    }

    await this.finalizeBatch(proposal, proposal.vaultId, batch);
    this.logger.log(`Batch ${batch.batchNumber} completed successfully: ${signed.txHash}`);
    return true;
  }

  /**
   * Settle a batch left in PROCESSING by an earlier run.
   *
   * Without a `txHash` it was never submitted (see {@link processBatch}) and is
   * queued for sending. With one, the chain decides: found → completed; not
   * found → the SAME signed tx is resubmitted (same inputs, so it lands at most
   * once). Only when the node refuses that exact tx for a reason that proves it
   * can never land (expired, invalid) is the batch released for a rebuild.
   * Anything else stays PROCESSING, is re-checked on the next run, and alerts.
   */
  private async reconcileInFlightBatch(proposal: Proposal, vaultId: string, batch: DistributionBatch): Promise<void> {
    if (!batch.txHash || !batch.signedTx) {
      this.logger.warn(`Batch ${batch.batchNumber}: interrupted before submission, queued for sending`);
      batch.status = DistributionBatchStatus.RETRY_PENDING;
      batch.txHash = undefined;
      batch.signedTx = undefined;
      batch.error = 'Interrupted before submission';
      await this.saveDistribution(proposal);
      return;
    }

    let onChain: boolean;
    try {
      onChain = await this.isTxOnChain(batch.txHash);
    } catch (error) {
      this.logger.error(`Batch ${batch.batchNumber}: cannot check tx ${batch.txHash} on chain: ${error.message}`);
      return; // stays PROCESSING, re-checked next run
    }

    if (onChain) {
      this.logger.log(`Batch ${batch.batchNumber}: tx ${batch.txHash} is on chain, marking completed`);
      await this.finalizeBatch(proposal, vaultId, batch);
      return;
    }

    try {
      await this.blockchainService.submitTransaction({ transaction: batch.signedTx });
      this.logger.log(`Batch ${batch.batchNumber}: resubmitted the same signed tx ${batch.txHash}`);
      await this.finalizeBatch(proposal, vaultId, batch);
      return;
    } catch (error) {
      // Spent inputs can mean THIS tx landed and the indexer has not caught up,
      // so only rejections that prove the tx can never land release the batch.
      if (error instanceof HttpException && !(error instanceof UtxoSpentException)) {
        this.logger.warn(
          `Batch ${batch.batchNumber}: tx ${batch.txHash} is not on chain and can never land (${error.message}); ` +
            `it will be rebuilt`
        );
        await this.markRejected(proposal, batch, error);
        return;
      }

      batch.error =
        `Tx ${batch.txHash} not found on chain and resubmission failed (${error.message}). ` +
        `Re-checked on every run; needs manual review if it persists.`;
      await this.saveDistribution(proposal);
      this.logger.error(`Batch ${batch.batchNumber}: ${batch.error}`);
      await this.alertsService.sendAlert('distribution_batch_unconfirmed', {
        proposalId: proposal.id,
        vaultId,
        batchId: batch.batchId,
        txHash: batch.txHash,
        error: error.message,
      });
    }
  }

  /** Record a batch as paid by `batch.txHash`. Idempotent: safe to repeat after a crash. */
  private async finalizeBatch(proposal: Proposal, vaultId: string, batch: DistributionBatch): Promise<void> {
    const txHash = batch.txHash!;

    let transaction = await this.transactionRepository.findOne({ where: { tx_hash: txHash } });
    if (!transaction) {
      // Convert lovelace to ADA for the amount field (must be integer if column is bigint)
      const amountInAda = Math.floor(Number(batch.lovelaceAmount) / 1_000_000);
      transaction = await this.transactionRepository.save({
        type: TransactionType.distribution,
        status: TransactionStatus.submitted,
        vault_id: vaultId,
        tx_hash: txHash,
        amount: amountInAda,
        metadata: {
          batchId: batch.batchId,
          recipientCount: batch.claimIds.length,
          lovelaceAmount: batch.lovelaceAmount, // Store exact lovelace amount in metadata
        },
      });
    }

    const claims = await this.claimRepository.find({ where: { id: In(batch.claimIds) } });
    for (const claim of claims) {
      const currentMetadata = claim.metadata as DistributionClaimMetadata;
      claim.status = ClaimStatus.CLAIMED;
      claim.distribution_tx_id = transaction.id;
      claim.metadata = {
        address: currentMetadata.address,
        batchId: batch.batchId,
      };
    }
    await this.claimRepository.save(claims);

    batch.status = DistributionBatchStatus.COMPLETED;
    batch.transactionId = transaction.id;
    batch.signedTx = undefined;
    batch.error = undefined;
    await this.saveDistribution(proposal);
  }

  /** The tx was never submitted, or the node proved it can never land: free to rebuild. */
  private async markRejected(proposal: Proposal, batch: DistributionBatch, error: Error): Promise<void> {
    batch.retryCount++;
    batch.error = error.message;
    batch.txHash = undefined;
    batch.signedTx = undefined;

    if (batch.retryCount >= this.MAX_RETRY_ATTEMPTS) {
      batch.status = DistributionBatchStatus.FAILED;
      await this.claimRepository.update(batch.claimIds, { status: ClaimStatus.FAILED });
    } else {
      batch.status = DistributionBatchStatus.RETRY_PENDING;
    }

    await this.saveDistribution(proposal);
  }

  /** Persist the batch plan, with counters derived from the batch statuses. */
  private async saveDistribution(proposal: Proposal): Promise<void> {
    const distribution = proposal.metadata.distribution as DistributionMetadata;
    distribution.completedBatches = distribution.batches.filter(
      b => b.status === DistributionBatchStatus.COMPLETED
    ).length;
    distribution.failedBatches = distribution.batches.filter(b => b.status === DistributionBatchStatus.FAILED).length;
    await this.proposalRepository.update({ id: proposal.id }, { metadata: proposal.metadata });
  }

  /** True if Blockfrost knows the tx; throws on errors other than "not found". */
  private async isTxOnChain(txHash: string): Promise<boolean> {
    try {
      await this.blockfrost.txs(txHash);
      return true;
    } catch (error) {
      if (error?.status_code === 404) return false;
      throw error;
    }
  }

  /**
   * Build and sign the distribution transaction. Returns its hash and hex
   * without submitting, so the caller can persist both first.
   */
  private async buildSignedDistributionTx(
    treasuryAddress: string,
    vaultId: string,
    claims: Claim[]
  ): Promise<{ txHash: string; signedTx: string }> {
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

    // Sign with the treasury payment and stake keys
    const signedTx = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
    signedTx.sign_and_add_vkey_signature(treasuryPrivateKey);
    signedTx.sign_and_add_vkey_signature(treasuryStakeKey);

    return { txHash: signedTx.transaction_hash().to_hex(), signedTx: signedTx.to_hex() };
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
    /** Batches not yet completed or permanently failed: pending, in flight, or queued for retry. */
    unresolvedBatches: number;
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
        unresolvedBatches: 0,
        totalDistributed: '0',
        batches: [],
      };
    }

    const distribution = proposal.metadata.distribution as DistributionMetadata;
    const pendingRetry = distribution.batches.filter(b => b.status === DistributionBatchStatus.RETRY_PENDING).length;
    const unresolvedBatches = distribution.batches.filter(b => UNFINISHED_BATCH_STATUSES.includes(b.status)).length;

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
    // `signedTx` is internal (a full signed tx); never hand it to API clients.
    const enrichedBatches = distribution.batches.map(({ signedTx: _signedTx, ...batch }) => ({
      ...batch,
      txHash: batch.transactionId ? txHashMap.get(batch.transactionId) : batch.txHash,
    }));

    return {
      status,
      totalBatches: distribution.batches.length,
      completedBatches: distribution.completedBatches,
      failedBatches: distribution.failedBatches,
      pendingRetry,
      unresolvedBatches,
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
