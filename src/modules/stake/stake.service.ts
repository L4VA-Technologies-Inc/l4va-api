import { createHash } from 'crypto';

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
import { normalizeLucidCardanoError } from '@/common/cardano/lucid-error-normalizer';
import { Transaction } from '@/database/transaction.entity';
import { UtxoRefDto } from '@/modules/stake/dto/unstake-tokens.dto';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

/** Transaction types that "renew" a box — their staked_at must also be trusted. */
const STAKE_LIKE_TYPES = [TransactionType.stake, TransactionType.harvest, TransactionType.compound];

/** Transaction types built from the admin wallet and requiring admin co-sign on submit. */
const ADMIN_SIGNED_TYPES = [TransactionType.unstake, TransactionType.harvest, TransactionType.compound];

type ProcessedBox = { utxo: UTxO; unit: string; deposit: bigint; reward: bigint; payout: bigint };

type AdminTxData = {
  ok: true;
  lucid: LucidEvolution;
  ownerHash: string;
  referenceUtxo: UTxO;
  eligibleBoxes: UTxO[];
  processedBoxes: ProcessedBox[];
  totalDepositAll: bigint;
  totalRewardAll: bigint;
};

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
  private readonly APY: number;
  private readonly TOKEN_DECIMALS = 4;

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

    const apyPercentRaw = this.configService.get<string>('STAKING_APY') ?? '8';
    const apyPercent = Number.parseFloat(apyPercentRaw);
    if (!Number.isFinite(apyPercent) || apyPercent < 0 || apyPercent > 100) {
      throw new Error(`Invalid STAKING_APY: expected a number between 0 and 100 (percent), got "${apyPercentRaw}"`);
    }
    this.APY = apyPercent / 100;
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
    return normalizeLucidCardanoError(error, fallback);
  }

  private static sha256Hex(input: string): string {
    return createHash('sha256').update(input).digest('hex');
  }

  private static bigintToSafeNumber(value: bigint, label: string): number {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    if (value > max || value < -max) {
      throw new Error(`${label} exceeds JS safe integer range`);
    }
    return Number(value);
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
   * Filters candidate UTxOs down to only those that pass the security check:
   * 1. trusted staked_at — datum matches a confirmed stake/harvest/compound record in the DB
   */
  private async getUnstakeEligibleBoxes(
    userId: string,
    userAddress: string,
    candidateBoxes: UTxO[]
  ): Promise<{ ok: true; boxes: UTxO[] } | { ok: false; message: string }> {
    const stakeRecords = await this.transactionRepository.find({
      where: {
        user_id: userId,
        type: In(STAKE_LIKE_TYPES),
        status: TransactionStatus.confirmed,
      },
      select: ['metadata'],
    });

    const trustedStakedAt = new Set(
      stakeRecords.map(r => Number(r.metadata?.staked_at)).filter(v => Number.isFinite(v) && v > 0)
    );

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

      return true;
    });

    if (verifiedBoxes.length < candidateBoxes.length) {
      this.logger.warn(
        `getUnstakeEligibleBoxes: ${candidateBoxes.length - verifiedBoxes.length} UTxO(s) rejected for ${userAddress} — ` +
          `proceeding with ${verifiedBoxes.length} eligible UTxO(s)`
      );
    }

    if (verifiedBoxes.length === 0) {
      return {
        ok: false,
        message: `No eligible UTxOs found. All positions were unverified.`,
      } as const;
    }

    return { ok: true, boxes: verifiedBoxes } as const;
  }

  /**
   * Resolves requested UTxO refs on-chain, verifies ownership, and returns
   * only those that actually exist and belong to this user.
   */
  private async resolveRequestedBoxes(
    lucid: LucidEvolution,
    userAddress: string,
    ownerHash: string,
    utxoRefs: UtxoRefDto[]
  ): Promise<{ ok: true; boxes: UTxO[] } | { ok: false; message: string }> {
    const scriptUtxos = await lucid.utxosAt(this.contractAddress);

    const refKey = (txHash: string, outputIndex: number): string => `${txHash}#${outputIndex}`;
    const requestedKeys = new Set(utxoRefs.map(r => refKey(r.txHash, r.outputIndex)));

    const requestedBoxes = scriptUtxos.filter(utxo => {
      if (!requestedKeys.has(refKey(utxo.txHash, utxo.outputIndex))) return false;
      if (!utxo.datum) return false;
      const decoded = tryDecodeStakeDatum(utxo.datum);
      return decoded !== null && decoded.owner === ownerHash;
    });

    if (requestedBoxes.length === 0) {
      return { ok: false, message: 'None of the requested UTxOs were found at the contract for your address.' };
    }

    if (requestedBoxes.length < utxoRefs.length) {
      this.logger.warn(
        `resolveRequestedBoxes: ${utxoRefs.length - requestedBoxes.length} requested UTxO(s) not found on-chain for ${userAddress}`
      );
    }

    return { ok: true, boxes: requestedBoxes };
  }

  /**
   * Shared setup for all admin-wallet operations (unstake, harvest, compound).
   * Initialises Lucid, verifies ownership, filters eligible boxes,
   * loads the reference script, and pre-computes per-box reward data.
   */
  private async prepareAdminTxData(
    userId: string,
    userAddress: string,
    utxoRefs: UtxoRefDto[]
  ): Promise<AdminTxData | { ok: false; message: string }> {
    const lucid = await this.getLucidForAdmin();

    const { paymentCredential } = getAddressDetails(userAddress);
    if (!paymentCredential?.hash) throw new Error('Invalid user address.');
    const ownerHash = paymentCredential.hash;

    const resolved = await this.resolveRequestedBoxes(lucid, userAddress, ownerHash, utxoRefs);
    if (resolved.ok === false) return { ok: false, message: resolved.message } as const;

    const eligible = await this.getUnstakeEligibleBoxes(userId, userAddress, resolved.boxes);
    if (eligible.ok === false) return { ok: false, message: eligible.message } as const;

    const [referenceUtxo] = await lucid.utxosByOutRef([
      { txHash: this.referenceScriptTxHash, outputIndex: this.referenceScriptIndex },
    ]);
    if (!referenceUtxo) throw new Error('Reference script not found.');

    let totalDepositAll = 0n;
    let totalRewardAll = 0n;

    const processedBoxes: ProcessedBox[] = [];
    for (const utxo of eligible.boxes) {
      const nonLovelaceUnits = Object.keys(utxo.assets).filter(k => k !== 'lovelace');
      if (nonLovelaceUnits.length !== 1) {
        return {
          ok: false,
          message:
            `Invalid stake box asset shape for ${utxo.txHash}#${utxo.outputIndex}: ` +
            `expected exactly one non-lovelace asset, found ${nonLovelaceUnits.length}.`,
        } as const;
      }

      const [unit] = nonLovelaceUnits;
      const { deposit, reward, payout } = this.calculateRewardForUtxo(unit, utxo);
      totalDepositAll += deposit;
      totalRewardAll += reward;
      processedBoxes.push({ utxo, unit, deposit, reward, payout });
    }

    return {
      ok: true,
      lucid,
      ownerHash,
      referenceUtxo,
      eligibleBoxes: eligible.boxes,
      processedBoxes,
      totalDepositAll,
      totalRewardAll,
    } as const;
  }

  /**
   * Returns all individual staked UTxO boxes belonging to this user, with
   * per-box reward estimates and eligibility status.
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

    const boxes: StakedBoxItem[] = myUtxos.map(utxo => {
      const decoded = tryDecodeStakeDatum(utxo.datum!)!;
      const stakedAt = Number(decoded.staked_at);

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
      const currentTimeMs = Date.now();

      const rawAmount = StakeService.toRawAmount(amount, this.TOKEN_DECIMALS);
      if (rawAmount <= 0n) throw new Error('Computed raw amount must be greater than 0.');

      const datum = encodeStakeDatum({ owner: ownerHash, staked_at: BigInt(currentTimeMs) });

      const tx = await lucid
        .newTx()
        .pay.ToContract(this.contractAddress, { kind: 'inline', value: datum }, { [unit]: rawAmount })
        .addSignerKey(ownerHash)
        .complete();

      const unsignedTxCbor = tx.toCBOR();
      const saved = await this.transactionRepository.save({
        type: TransactionType.stake,
        status: TransactionStatus.created,
        user_id: userId,
        utxo_input: userAddress,
        utxo_output: this.contractAddress,
        amount: StakeService.bigintToSafeNumber(rawAmount, 'stake rawAmount'),
        metadata: {
          assetId: unit,
          policyId,
          assetName: assetNameHex,
          humanAmount: amount,
          decimals: this.TOKEN_DECIMALS,
          rawAmount: rawAmount.toString(),
          staked_at: currentTimeMs,
          unsignedTxCborHash: StakeService.sha256Hex(unsignedTxCbor),
          contractAddress: this.contractAddress,
          referenceScript: {
            txHash: this.referenceScriptTxHash,
            outputIndex: this.referenceScriptIndex,
          },
          cardanoNetwork: this.isMainnet ? 'mainnet' : 'preprod',
        },
      });

      return { success: true, txCbor: unsignedTxCbor, transactionId: saved.id };
    } catch (error: unknown) {
      this.logger.error('buildStakeTx failed', error instanceof Error ? error.stack : String(error));
      return { success: false, message: StakeService.formatErrorMessage(error, 'buildStakeTx failed') };
    }
  }

  /**
   * Unstake: collect selected boxes, send full payout (deposit + reward) to user.
   */
  async buildUnstakeTx(userId: string, userAddress: string, utxoRefs: UtxoRefDto[]): Promise<BuildTxRes> {
    try {
      const prep = await this.prepareAdminTxData(userId, userAddress, utxoRefs);
      if (prep.ok === false) return { success: false, message: prep.message };

      const { lucid, ownerHash, referenceUtxo, eligibleBoxes, processedBoxes, totalDepositAll, totalRewardAll } = prep;

      const payoutByUnit = new Map<string, bigint>();
      for (const box of processedBoxes) {
        payoutByUnit.set(box.unit, (payoutByUnit.get(box.unit) ?? 0n) + box.payout);
      }

      this.logger.log(
        `buildUnstakeTx: ${eligibleBoxes.length} eligible UTxO(s) for ${userAddress} — ` +
          `deposit=${totalDepositAll}, reward=${totalRewardAll}, payout=${totalDepositAll + totalRewardAll}`
      );

      const redeemer = Data.to(new Constr(0, []));
      const tx = await lucid
        .newTx()
        .readFrom([referenceUtxo])
        .collectFrom(eligibleBoxes, redeemer)
        .pay.ToAddress(userAddress, Object.fromEntries(payoutByUnit.entries()))
        .addSignerKey(ownerHash)
        .complete();

      const unsignedTxCbor = tx.toCBOR();
      const saved = await this.transactionRepository.save({
        type: TransactionType.unstake,
        status: TransactionStatus.created,
        user_id: userId,
        utxo_input: this.contractAddress,
        utxo_output: userAddress,
        amount: StakeService.bigintToSafeNumber(totalDepositAll + totalRewardAll, 'unstake rawPayoutAmount'),
        metadata: {
          utxos: eligibleBoxes.map(u => ({ txHash: u.txHash, outputIndex: u.outputIndex })),
          decimals: this.TOKEN_DECIMALS,
          rawDepositAmount: totalDepositAll.toString(),
          rawRewardAmount: totalRewardAll.toString(),
          rawPayoutAmount: (totalDepositAll + totalRewardAll).toString(),
          depositAmount: StakeService.toHumanAmount(totalDepositAll, this.TOKEN_DECIMALS),
          rewardAmount: StakeService.toHumanAmount(totalRewardAll, this.TOKEN_DECIMALS),
          payoutAmount: StakeService.toHumanAmount(totalDepositAll + totalRewardAll, this.TOKEN_DECIMALS),
          utxoCount: eligibleBoxes.length,
          unsignedTxCborHash: StakeService.sha256Hex(unsignedTxCbor),
          contractAddress: this.contractAddress,
          referenceScript: {
            txHash: this.referenceScriptTxHash,
            outputIndex: this.referenceScriptIndex,
          },
          cardanoNetwork: this.isMainnet ? 'mainnet' : 'preprod',
        },
      });

      return { success: true, txCbor: unsignedTxCbor, transactionId: saved.id };
    } catch (error: unknown) {
      this.logger.error('buildUnstakeTx failed', error instanceof Error ? error.stack : String(error));
      return { success: false, message: StakeService.formatErrorMessage(error, 'buildUnstakeTx failed') };
    }
  }

  /**
   * Harvest: collect selected boxes, send rewards to user, re-lock deposits in
   * a new box with staked_at = now (resetting the reward timer).
   */
  async buildHarvestTx(userId: string, userAddress: string, utxoRefs: UtxoRefDto[]): Promise<BuildTxRes> {
    try {
      const prep = await this.prepareAdminTxData(userId, userAddress, utxoRefs);
      if (prep.ok === false) return { success: false, message: prep.message };

      const { lucid, ownerHash, referenceUtxo, eligibleBoxes, processedBoxes, totalDepositAll, totalRewardAll } = prep;

      const depositByUnit = new Map<string, bigint>();
      const rewardByUnit = new Map<string, bigint>();
      for (const box of processedBoxes) {
        depositByUnit.set(box.unit, (depositByUnit.get(box.unit) ?? 0n) + box.deposit);
        rewardByUnit.set(box.unit, (rewardByUnit.get(box.unit) ?? 0n) + box.reward);
      }

      this.logger.log(
        `buildHarvestTx: ${eligibleBoxes.length} eligible UTxO(s) for ${userAddress} — ` +
          `deposit=${totalDepositAll}, reward=${totalRewardAll}`
      );

      const now = Date.now();
      const redeemer = Data.to(new Constr(0, []));
      let txBuilder = lucid.newTx().readFrom([referenceUtxo]).collectFrom(eligibleBoxes, redeemer);

      for (const [unit, deposit] of depositByUnit.entries()) {
        const datum = encodeStakeDatum({ owner: ownerHash, staked_at: BigInt(now) });
        txBuilder = txBuilder.pay.ToContract(
          this.contractAddress,
          { kind: 'inline', value: datum },
          { [unit]: deposit }
        );
      }

      txBuilder = txBuilder.pay.ToAddress(userAddress, Object.fromEntries(rewardByUnit.entries()));
      const tx = await txBuilder.addSignerKey(ownerHash).complete();

      const unsignedTxCbor = tx.toCBOR();
      const saved = await this.transactionRepository.save({
        type: TransactionType.harvest,
        status: TransactionStatus.created,
        user_id: userId,
        utxo_input: this.contractAddress,
        utxo_output: userAddress,
        amount: StakeService.bigintToSafeNumber(totalRewardAll, 'harvest rawRewardAmount'),
        metadata: {
          utxos: eligibleBoxes.map(u => ({ txHash: u.txHash, outputIndex: u.outputIndex })),
          decimals: this.TOKEN_DECIMALS,
          rawDepositAmount: totalDepositAll.toString(),
          rawRewardAmount: totalRewardAll.toString(),
          depositAmount: StakeService.toHumanAmount(totalDepositAll, this.TOKEN_DECIMALS),
          rewardAmount: StakeService.toHumanAmount(totalRewardAll, this.TOKEN_DECIMALS),
          staked_at: now,
          utxoCount: eligibleBoxes.length,
          unsignedTxCborHash: StakeService.sha256Hex(unsignedTxCbor),
          contractAddress: this.contractAddress,
          referenceScript: {
            txHash: this.referenceScriptTxHash,
            outputIndex: this.referenceScriptIndex,
          },
          cardanoNetwork: this.isMainnet ? 'mainnet' : 'preprod',
        },
      });

      return { success: true, txCbor: unsignedTxCbor, transactionId: saved.id };
    } catch (error: unknown) {
      this.logger.error('buildHarvestTx failed', error instanceof Error ? error.stack : String(error));
      return { success: false, message: StakeService.formatErrorMessage(error, 'buildHarvestTx failed') };
    }
  }

  /**
   * Compound: collect selected boxes, re-lock deposit + reward in a new box
   * with staked_at = now. Nothing is sent to the user — rewards are compounded.
   */
  async buildCompoundTx(userId: string, userAddress: string, utxoRefs: UtxoRefDto[]): Promise<BuildTxRes> {
    try {
      const prep = await this.prepareAdminTxData(userId, userAddress, utxoRefs);
      if (prep.ok === false) return { success: false, message: prep.message };

      const { lucid, ownerHash, referenceUtxo, eligibleBoxes, processedBoxes, totalDepositAll, totalRewardAll } = prep;

      const newAmountByUnit = new Map<string, bigint>();
      for (const box of processedBoxes) {
        newAmountByUnit.set(box.unit, (newAmountByUnit.get(box.unit) ?? 0n) + box.payout);
      }

      this.logger.log(
        `buildCompoundTx: ${eligibleBoxes.length} eligible UTxO(s) for ${userAddress} — ` +
          `deposit=${totalDepositAll}, reward=${totalRewardAll}, newDeposit=${totalDepositAll + totalRewardAll}`
      );

      const now = Date.now();
      const redeemer = Data.to(new Constr(0, []));
      let txBuilder = lucid.newTx().readFrom([referenceUtxo]).collectFrom(eligibleBoxes, redeemer);

      for (const [unit, newAmount] of newAmountByUnit.entries()) {
        const datum = encodeStakeDatum({ owner: ownerHash, staked_at: BigInt(now) });
        txBuilder = txBuilder.pay.ToContract(
          this.contractAddress,
          { kind: 'inline', value: datum },
          { [unit]: newAmount }
        );
      }

      const tx = await txBuilder.addSignerKey(ownerHash).complete();

      const unsignedTxCbor = tx.toCBOR();
      const saved = await this.transactionRepository.save({
        type: TransactionType.compound,
        status: TransactionStatus.created,
        user_id: userId,
        utxo_input: this.contractAddress,
        utxo_output: this.contractAddress,
        amount: StakeService.bigintToSafeNumber(totalDepositAll + totalRewardAll, 'compound rawNewDepositAmount'),
        metadata: {
          utxos: eligibleBoxes.map(u => ({ txHash: u.txHash, outputIndex: u.outputIndex })),
          decimals: this.TOKEN_DECIMALS,
          rawDepositAmount: totalDepositAll.toString(),
          rawRewardAmount: totalRewardAll.toString(),
          rawNewDepositAmount: (totalDepositAll + totalRewardAll).toString(),
          depositAmount: StakeService.toHumanAmount(totalDepositAll, this.TOKEN_DECIMALS),
          rewardAmount: StakeService.toHumanAmount(totalRewardAll, this.TOKEN_DECIMALS),
          newDepositAmount: StakeService.toHumanAmount(totalDepositAll + totalRewardAll, this.TOKEN_DECIMALS),
          staked_at: now,
          utxoCount: eligibleBoxes.length,
          unsignedTxCborHash: StakeService.sha256Hex(unsignedTxCbor),
          contractAddress: this.contractAddress,
          referenceScript: {
            txHash: this.referenceScriptTxHash,
            outputIndex: this.referenceScriptIndex,
          },
          cardanoNetwork: this.isMainnet ? 'mainnet' : 'preprod',
        },
      });

      return { success: true, txCbor: unsignedTxCbor, transactionId: saved.id };
    } catch (error: unknown) {
      this.logger.error('buildCompoundTx failed', error instanceof Error ? error.stack : String(error));
      return { success: false, message: StakeService.formatErrorMessage(error, 'buildCompoundTx failed') };
    }
  }

  /**
   * Finds the existing `created` transaction, submits the signed CBOR and updates
   * the record with `tx_hash` + status `submitted`.
   */
  async submitTransaction(userId: string, dto: SubmitStakeTxDto): Promise<SubmitTxRes> {
    const { txCbor, signature, transactionId } = dto;

    const transaction = await this.transactionRepository.findOne({ where: { id: transactionId, user_id: userId } });
    if (!transaction) return { success: false, message: 'Transaction not found.' };

    try {
      const isAdminSigned = ADMIN_SIGNED_TYPES.includes(transaction.type as TransactionType);

      // Prevent malicious txCbor substitution: require that submitted CBOR matches
      // what the backend originally built for this transactionId.
      const expectedHash = transaction.metadata?.unsignedTxCborHash;
      if (typeof expectedHash === 'string' && expectedHash.length > 0) {
        const gotHash = StakeService.sha256Hex(txCbor);
        if (gotHash !== expectedHash) {
          return {
            success: false,
            message: 'Unsigned transaction mismatch. Please rebuild and try again.',
          };
        }
      } else if (isAdminSigned) {
        return {
          success: false,
          message: 'Server cannot verify unsigned transaction. Please rebuild and try again.',
        };
      }

      const updateResult = await this.transactionRepository.update(
        { id: transactionId, user_id: userId, status: TransactionStatus.created },
        { status: TransactionStatus.pending }
      );

      if (!updateResult.affected) {
        return {
          success: false,
          message: 'Transaction not found, already processing, or already submitted.',
        };
      }

      const userAddress = transaction.utxo_input;
      const lucid = isAdminSigned ? await this.getLucidForAdmin() : await this.getLucidForUser(userAddress);

      const signBuilder = lucid.fromTx(txCbor).assemble([signature]);

      const signedTx = isAdminSigned
        ? await signBuilder.sign.withPrivateKey(this.adminSKey).complete()
        : await signBuilder.complete();

      const txHash = await signedTx.submit();

      // mark transaction as confirmed, not necessary to mark it as submitted
      await this.transactionRepository.update(
        { id: transactionId },
        { tx_hash: txHash, status: TransactionStatus.confirmed }
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
