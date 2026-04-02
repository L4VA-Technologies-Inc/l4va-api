import {
  Constr,
  Data,
  Lucid,
  getAddressDetails,
  type LucidEvolution,
  type Network,
  type UTxO,
} from '@lucid-evolution/lucid';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { BuildTxRes } from './dto/build-tx.res';
import { StakedBalanceRes, StakedBoxItem } from './dto/staked-balance.res';
import { SubmitStakeTxDto } from './dto/submit-stake-tx.dto';
import { SubmitTxRes } from './dto/submit-tx.res';
import { encodeStakeDatum, tryDecodeStakeDatum } from './stake-datum';

import { createLucidBlockfrostProvider, lucidNetworkFromCardanoEnv } from '@/common/cardano/blockfrost-lucid';
import { Transaction } from '@/database/transaction.entity';
import { UtxoRefDto } from '@/modules/stake/dto/unstake-tokens.dto';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

@Injectable()
export class StakeService {
  private readonly logger = new Logger(StakeService.name);

  private readonly isMainnet: boolean;
  private readonly network: Network;
  private readonly blockfrostProjectId: string;
  private readonly contractAddress: string;
  private readonly referenceScriptTxHash: string;
  private readonly referenceScriptIndex: number;
  private readonly adminAddress: string;
  private readonly adminSKey: string;
  private readonly APY = 0.12; // 12% p.a.
  private readonly TOKEN_DECIMALS = 4;
  private readonly unstakeCooldownMs: number;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>
  ) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    this.network = lucidNetworkFromCardanoEnv(this.isMainnet);
    this.blockfrostProjectId = this.configService.getOrThrow<string>('BLOCKFROST_API_KEY');
    this.contractAddress = this.configService.getOrThrow<string>('CONTRACT_ADDRESS');
    this.referenceScriptTxHash = this.configService.getOrThrow<string>('REFERENCE_SCRIPT_TX_HASH');
    this.referenceScriptIndex = parseInt(this.configService.get<string>('REFERENCE_SCRIPT_INDEX') ?? '0', 10);
    this.adminAddress = this.configService.getOrThrow<string>('ADMIN_ADDRESS');
    this.adminSKey = this.configService.getOrThrow<string>('ADMIN_S_KEY');

    const cooldownDaysRaw = this.configService.get<string>('UNSTAKE_COOLDOWN_DAYS') ?? '30';
    const cooldownDays = Number.parseInt(cooldownDaysRaw, 10);
    const safeCooldownDays = Number.isFinite(cooldownDays) && cooldownDays > 0 ? cooldownDays : 30;
    this.unstakeCooldownMs = safeCooldownDays * 24 * 60 * 60 * 1000;
  }

  private async createLucid(): Promise<LucidEvolution> {
    return Lucid(createLucidBlockfrostProvider(this.blockfrostProjectId, this.network), this.network);
  }

  private async getLucidForUser(userAddress: string): Promise<LucidEvolution> {
    const lucid = await this.createLucid();
    const utxos = await lucid.utxosAt(userAddress);
    lucid.selectWallet.fromAddress(userAddress, utxos);
    return lucid;
  }

  private async getLucidForAdmin(): Promise<LucidEvolution> {
    const lucid = await this.createLucid();
    const utxos = await lucid.utxosAt(this.adminAddress);
    lucid.selectWallet.fromAddress(this.adminAddress, utxos);
    return lucid;
  }

  private static formatErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string') return error;
    return fallback;
  }

  /**
   * Converts a human-readable token amount to the raw on-chain integer.
   * E.g. amount=100.56, decimals=4 → 1_005_600n
   */
  private static toRawAmount(amount: number, decimals: number): bigint {
    return BigInt(Math.round(amount * Math.pow(10, decimals)));
  }

  /**
   * Converts a raw on-chain integer back to a human-readable number.
   * E.g. raw=1_005_600n, decimals=4 → 100.56
   */
  private static toHumanAmount(raw: bigint, decimals: number): number {
    return Number(raw) / Math.pow(10, decimals);
  }

  private calculateRewardForUtxo(unit: string, utxo: UTxO): { deposit: bigint; reward: bigint; payout: bigint } {
    const MS_IN_YEAR = 365 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const amount = utxo.assets[unit] ?? 0n;
    const decoded = tryDecodeStakeDatum(utxo.datum!);
    const elapsed = now - Number(decoded!.staked_at);
    const reward = BigInt(Math.floor((Number(amount) * this.APY * elapsed) / MS_IN_YEAR));
    return { deposit: amount, reward, payout: amount + reward };
  }

  /**
   * Filters candidate UTxOs down to only those that pass both security checks:
   * 1. trusted staked_at — datum matches a confirmed stake record in the DB
   * 2. cooldown — enough time has passed since staking
   *
   * `unit` is intentionally absent: we load all confirmed stake records for the
   * user so the same check works for single- or multi-asset unstake requests.
   */
  private async getUnstakeEligibleBoxes(
    userId: string,
    userAddress: string,
    candidateBoxes: UTxO[]
  ): Promise<{ ok: true; boxes: UTxO[] } | { ok: false; message: string }> {
    const stakeRecords = await this.transactionRepository.find({
      where: {
        user_id: userId,
        type: TransactionType.stake,
        status: In([TransactionStatus.confirmed, TransactionStatus.submitted]),
      },
      select: ['metadata'],
    });

    // Build a set of all trusted staked_at timestamps across all assets for this user.
    const trustedStakedAt = new Set(
      stakeRecords.map(r => Number(r.metadata?.staked_at)).filter(v => Number.isFinite(v) && v > 0)
    );

    const now = Date.now();

    const verifiedBoxes = candidateBoxes.filter(utxo => {
      const decoded = tryDecodeStakeDatum(utxo.datum!);
      const stakedAt = Number(decoded!.staked_at);

      if (!trustedStakedAt.has(stakedAt)) {
        this.logger.warn(
          `getUnstakeEligibleBoxes: rejecting UTxO ${utxo.txHash}#${utxo.outputIndex} ` +
            `with unverified staked_at=${stakedAt} for user ${userId} — no matching DB stake record`
        );
        return false;
      }

      const elapsed = now - stakedAt;
      if (elapsed < this.unstakeCooldownMs) {
        this.logger.log(
          `getUnstakeEligibleBoxes: cooldown not met for UTxO ${utxo.txHash}#${utxo.outputIndex} ` +
            `(elapsed=${elapsed}ms, required=${this.unstakeCooldownMs}ms)`
        );
        return false;
      }

      return true;
    });

    if (verifiedBoxes.length < candidateBoxes.length) {
      this.logger.warn(
        `getUnstakeEligibleBoxes: ${candidateBoxes.length - verifiedBoxes.length} UTxO(s) rejected for ${userAddress} — ` +
          `proceeding with ${verifiedBoxes.length} eligible UTxO(s)`
      );
    }

    if (verifiedBoxes.length === 0) {
      const days = Math.ceil(this.unstakeCooldownMs / (24 * 60 * 60 * 1000));
      return {
        ok: false,
        message: `No eligible UTxOs found. All positions were either unverified or still within the ${days}-day cooldown.`,
      } as const;
    }

    return { ok: true, boxes: verifiedBoxes } as const;
  }

  /**
   * Returns all individual staked UTxO boxes belonging to this user, with
   * per-box reward estimates and eligibility status. The frontend uses this
   * to let the user pick which boxes to unstake.
   */
  async getOnChainStakedBalance(userId: string, userAddress: string): Promise<StakedBalanceRes> {
    const { paymentCredential } = getAddressDetails(userAddress);
    if (!paymentCredential?.hash) throw new Error('Invalid user address.');
    const ownerHash = paymentCredential.hash;

    const lucid = await this.createLucid();
    const scriptUtxos = await lucid.utxosAt(this.contractAddress);

    const myUtxos = scriptUtxos.filter(utxo => {
      if (!utxo.datum) return false;
      const decoded = tryDecodeStakeDatum(utxo.datum);
      return decoded !== null && decoded.owner === ownerHash;
    });

    if (myUtxos.length === 0) {
      return { boxes: [] };
    }

    const eligible = await this.getUnstakeEligibleBoxes(userId, userAddress, myUtxos);
    const eligibleSet = new Set(eligible.ok ? eligible.boxes.map(u => `${u.txHash}#${u.outputIndex}`) : []);

    const now = Date.now();
    const boxes: StakedBoxItem[] = myUtxos.map(utxo => {
      const decoded = tryDecodeStakeDatum(utxo.datum!)!;
      const stakedAt = Number(decoded.staked_at);
      const cooldownEndsAt = stakedAt + this.unstakeCooldownMs;

      // Derive unit from the non-lovelace asset in this UTxO.
      const unit = Object.keys(utxo.assets).find(k => k !== 'lovelace') ?? '';
      const { deposit, reward, payout } = this.calculateRewardForUtxo(unit, utxo);

      return {
        txHash: utxo.txHash,
        outputIndex: utxo.outputIndex,
        unit,
        policyId: unit.slice(0, 56),
        stakedAmount: StakeService.toHumanAmount(deposit, this.TOKEN_DECIMALS),
        stakedAt,
        estimatedReward: StakeService.toHumanAmount(reward, this.TOKEN_DECIMALS),
        estimatedPayout: StakeService.toHumanAmount(payout, this.TOKEN_DECIMALS),
        eligible: eligibleSet.has(`${utxo.txHash}#${utxo.outputIndex}`),
        cooldownEndsAt: Math.max(cooldownEndsAt, now),
      };
    });

    return { boxes };
  }

  /**
   * 1. Creates a `created` ledger row.
   * 2. Builds the unsigned transaction via Lucid.
   * 3. Returns `txCbor` + `transactionId` — both are passed to `submitTransaction`.
   */
  async buildStakeTx(userId: string, userAddress: string, assetId: string, amount: number): Promise<BuildTxRes> {
    try {
      const lucid = await this.getLucidForUser(userAddress);

      const { paymentCredential } = getAddressDetails(userAddress);
      if (!paymentCredential?.hash) throw new Error('Invalid user address.');

      const ownerHash = paymentCredential.hash;
      const unit = assetId.trim().toLowerCase();
      const policyId = unit.slice(0, 56);
      const assetNameHex = unit.slice(56);
      const ONE_DAY_MS = 24 * 60 * 60 * 1000;
      const ONE_YEAR_MS = 365 * ONE_DAY_MS;

      const currentTimeMs = Date.now() - ONE_YEAR_MS;

      // Convert human-readable amount to raw on-chain integer.
      // E.g. amount=100.56 → 1_005_600n  (TOKEN_DECIMALS=4)
      const rawAmount = StakeService.toRawAmount(amount, this.TOKEN_DECIMALS);
      if (rawAmount <= 0n) throw new Error('Computed raw amount must be greater than 0.');

      const datum = encodeStakeDatum({ owner: ownerHash, staked_at: BigInt(currentTimeMs) });

      const tx = await lucid
        .newTx()
        .pay.ToContract(this.contractAddress, { kind: 'inline', value: datum }, { [unit]: rawAmount })
        .addSignerKey(ownerHash)
        .complete();

      const saved = await this.transactionRepository.save({
        type: TransactionType.stake,
        status: TransactionStatus.created,
        user_id: userId,
        utxo_input: userAddress,
        utxo_output: this.contractAddress,
        amount: Number(rawAmount),
        metadata: {
          assetId: unit,
          policyId,
          assetName: assetNameHex,
          humanAmount: amount,
          decimals: this.TOKEN_DECIMALS,
          rawAmount: Number(rawAmount),
          // Persisted so buildUnstakeTx can verify the datum's staked_at against
          // a real API-originated stake record, blocking fake/inflated datums.
          staked_at: currentTimeMs,
          contractAddress: this.contractAddress,
          referenceScript: {
            txHash: this.referenceScriptTxHash,
            outputIndex: this.referenceScriptIndex,
          },
          cardanoNetwork: this.isMainnet ? 'mainnet' : 'preprod',
        },
      });

      return { success: true, txCbor: tx.toCBOR(), transactionId: saved.id };
    } catch (error: unknown) {
      this.logger.error('buildStakeTx failed', error instanceof Error ? error.stack : String(error));
      return { success: false, message: StakeService.formatErrorMessage(error, 'buildStakeTx failed') };
    }
  }

  /**
   * 1. Resolves requested UTxO refs on-chain and verifies ownership.
   * 2. Runs eligibility check (trusted staked_at + cooldown).
   * 3. Builds the transaction from the admin wallet for only the selected boxes.
   * 4. Supports boxes with different token units in a single transaction.
   * 5. Creates an `unstake` ledger row and returns `txCbor` + `transactionId`.
   */
  async buildUnstakeTx(userId: string, userAddress: string, utxoRefs: UtxoRefDto[]): Promise<BuildTxRes> {
    try {
      const lucid = await this.getLucidForAdmin();

      const { paymentCredential } = getAddressDetails(userAddress);
      if (!paymentCredential?.hash) throw new Error('Invalid user address.');
      const ownerHash = paymentCredential.hash;

      const scriptUtxos = await lucid.utxosAt(this.contractAddress);

      // Build a lookup map for fast resolution of requested refs.
      const refKey = (txHash: string, outputIndex: number): string => `${txHash}#${outputIndex}`;
      const requestedKeys = new Set(utxoRefs.map(r => refKey(r.txHash, r.outputIndex)));

      // Find the on-chain UTxOs matching the requested refs that also belong to this user.
      const requestedBoxes = scriptUtxos.filter(utxo => {
        if (!requestedKeys.has(refKey(utxo.txHash, utxo.outputIndex))) return false;
        if (!utxo.datum) return false;
        const decoded = tryDecodeStakeDatum(utxo.datum);
        return decoded !== null && decoded.owner === ownerHash;
      });

      if (requestedBoxes.length === 0) {
        return { success: false, message: 'None of the requested UTxOs were found at the contract for your address.' };
      }

      if (requestedBoxes.length < utxoRefs.length) {
        this.logger.warn(
          `buildUnstakeTx: ${utxoRefs.length - requestedBoxes.length} requested UTxO(s) not found on-chain for ${userAddress}`
        );
      }

      const eligible = await this.getUnstakeEligibleBoxes(userId, userAddress, requestedBoxes);
      if (eligible.ok === false) return { success: false, message: eligible.message };
      const eligibleBoxes = eligible.boxes;

      // Aggregate payout per unit — supports unstaking different tokens in one tx.
      const payoutByUnit = new Map<string, bigint>();
      let totalDepositAll = 0n;
      let totalRewardAll = 0n;

      for (const utxo of eligibleBoxes) {
        const unit = Object.keys(utxo.assets).find(k => k !== 'lovelace') ?? '';
        const { deposit, reward, payout } = this.calculateRewardForUtxo(unit, utxo);
        payoutByUnit.set(unit, (payoutByUnit.get(unit) ?? 0n) + payout);
        totalDepositAll += deposit;
        totalRewardAll += reward;
      }

      this.logger.log(
        `buildUnstakeTx: ${eligibleBoxes.length} eligible UTxO(s) for ${userAddress} — ` +
          `deposit=${totalDepositAll}, reward=${totalRewardAll}, payout=${totalDepositAll + totalRewardAll}`
      );

      const redeemer = Data.to(new Constr(0, []));

      const [referenceUtxo] = await lucid.utxosByOutRef([
        { txHash: this.referenceScriptTxHash, outputIndex: this.referenceScriptIndex },
      ]);

      if (!referenceUtxo) throw new Error('Reference script not found.');

      // Build the payout assets object (may contain multiple units).
      const payoutAssets = Object.fromEntries(payoutByUnit.entries());

      const tx = await lucid
        .newTx()
        .readFrom([referenceUtxo])
        .collectFrom(eligibleBoxes, redeemer)
        .pay.ToAddress(userAddress, payoutAssets)
        .addSignerKey(ownerHash)
        .complete();

      const saved = await this.transactionRepository.save({
        type: TransactionType.unstake,
        status: TransactionStatus.created,
        user_id: userId,
        utxo_input: this.contractAddress,
        utxo_output: userAddress,
        amount: Number(totalDepositAll + totalRewardAll),
        metadata: {
          utxos: eligibleBoxes.map(u => ({ txHash: u.txHash, outputIndex: u.outputIndex })),
          decimals: this.TOKEN_DECIMALS,
          rawDepositAmount: Number(totalDepositAll),
          rawRewardAmount: Number(totalRewardAll),
          rawPayoutAmount: Number(totalDepositAll + totalRewardAll),
          depositAmount: StakeService.toHumanAmount(totalDepositAll, this.TOKEN_DECIMALS),
          rewardAmount: StakeService.toHumanAmount(totalRewardAll, this.TOKEN_DECIMALS),
          payoutAmount: StakeService.toHumanAmount(totalDepositAll + totalRewardAll, this.TOKEN_DECIMALS),
          utxoCount: eligibleBoxes.length,
          contractAddress: this.contractAddress,
          referenceScript: {
            txHash: this.referenceScriptTxHash,
            outputIndex: this.referenceScriptIndex,
          },
          cardanoNetwork: this.isMainnet ? 'mainnet' : 'preprod',
        },
      });

      return { success: true, txCbor: tx.toCBOR(), transactionId: saved.id };
    } catch (error: unknown) {
      this.logger.error('buildUnstakeTx failed', error instanceof Error ? error.stack : String(error));
      return { success: false, message: StakeService.formatErrorMessage(error, 'buildUnstakeTx failed') };
    }
  }

  /**
   * Finds the existing `created` transaction, submits the signed CBOR and updates
   * the record with `tx_hash` + status `submitted`.
   * Only `txCbor`, `signature` and `transactionId` are required — no extra metadata.
   */
  async submitTransaction(userId: string, dto: SubmitStakeTxDto): Promise<SubmitTxRes> {
    const { txCbor, signature, transactionId } = dto;

    const transaction = await this.transactionRepository.findOne({
      where: { id: transactionId, user_id: userId },
    });

    if (!transaction) {
      return { success: false, message: 'Transaction not found or does not belong to this user.' };
    }

    try {
      const userAddress = transaction.utxo_input;
      const lucid =
        transaction.type === TransactionType.unstake
          ? await this.getLucidForAdmin()
          : await this.getLucidForUser(userAddress);

      const signBuilder = lucid.fromTx(txCbor).assemble([signature]);

      const signedTx =
        transaction.type === TransactionType.unstake
          ? await signBuilder.sign.withPrivateKey(this.adminSKey).complete()
          : await signBuilder.complete();

      const txHash = await signedTx.submit();

      await this.transactionRepository.update(
        { id: transactionId },
        { tx_hash: txHash, status: TransactionStatus.submitted }
      );

      this.logger.log(`${transaction.type} transaction submitted! Hash: ${txHash}, dbId: ${transactionId}`);
      return { success: true, txHash, transactionId };
    } catch (error: unknown) {
      this.logger.error('submitTransaction failed', error instanceof Error ? error.stack : String(error));

      await this.transactionRepository
        .update({ id: transactionId }, { status: TransactionStatus.failed })
        .catch(err => this.logger.error('Failed to mark transaction as failed', err));

      return {
        success: false,
        message: StakeService.formatErrorMessage(error, 'Submit failed'),
      };
    }
  }
}
