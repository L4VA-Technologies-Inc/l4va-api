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
  /** Fallback decimals for unknown tokens */
  private readonly TOKEN_DECIMALS = 4;
  /** unit (policyId + assetName hex, lowercase) → decimal precision */
  private readonly knownTokens: Map<string, number>;

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

    this.knownTokens = this.buildKnownTokensMap();
  }

  private buildKnownTokensMap(): Map<string, number> {
    const map = new Map<string, number>();

    const vlrmPolicy = this.configService.get<string>('VLRM_POLICY_ID')?.toLowerCase();
    const vlrmName = this.configService.get<string>('VLRM_HEX_ASSET_NAME')?.toLowerCase() ?? '';
    const vlrmDecimals = parseInt(this.configService.get<string>('VLRM_DECIMALS') ?? '4', 10);
    if (vlrmPolicy) {
      map.set(`${vlrmPolicy}${vlrmName}`, Number.isFinite(vlrmDecimals) ? vlrmDecimals : 4);
    }

    const l4vaPolicy = this.configService.get<string>('L4VA_POLICY_ID')?.toLowerCase();
    const l4vaName = this.configService.get<string>('L4VA_ASSET_NAME')?.toLowerCase() ?? '';
    const l4vaDecimals = parseInt(this.configService.get<string>('L4VA_DECIMALS') ?? '3', 10);
    if (l4vaPolicy) {
      map.set(`${l4vaPolicy}${l4vaName}`, Number.isFinite(l4vaDecimals) ? l4vaDecimals : 3);
    }

    return map;
  }

  private getDecimalsForUnit(unit: string): number {
    return this.knownTokens.get(unit.toLowerCase()) ?? this.TOKEN_DECIMALS;
  }

  /**
   * Groups processed boxes by token unit and builds a per-token summary with
   * human-readable amounts (correct decimals per token).
   */
  private buildTokensSummary(processedBoxes: ProcessedBox[]): Array<{
    unit: string;
    policyId: string;
    decimals: number;
    rawDeposit: string;
    rawReward: string;
    rawPayout: string;
    depositAmount: number;
    rewardAmount: number;
    payoutAmount: number;
  }> {
    const byUnit = new Map<string, { deposit: bigint; reward: bigint; payout: bigint }>();
    for (const box of processedBoxes) {
      const acc = byUnit.get(box.unit) ?? { deposit: 0n, reward: 0n, payout: 0n };
      acc.deposit += box.deposit;
      acc.reward += box.reward;
      acc.payout += box.payout;
      byUnit.set(box.unit, acc);
    }
    return Array.from(byUnit.entries()).map(([unit, amounts]) => {
      const decimals = this.getDecimalsForUnit(unit);
      return {
        unit,
        policyId: unit.slice(0, 56),
        decimals,
        rawDeposit: amounts.deposit.toString(),
        rawReward: amounts.reward.toString(),
        rawPayout: amounts.payout.toString(),
        depositAmount: StakeService.toHumanAmount(amounts.deposit, decimals),
        rewardAmount: StakeService.toHumanAmount(amounts.reward, decimals),
        payoutAmount: StakeService.toHumanAmount(amounts.payout, decimals),
      };
    });
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
      const decimals = this.getDecimalsForUnit(unit);

      return {
        txHash: utxo.txHash,
        outputIndex: utxo.outputIndex,
        unit,
        policyId: unit.slice(0, 56),
        stakedAmount: StakeService.toHumanAmount(deposit, decimals),
        stakedAt,
        estimatedReward: StakeService.toHumanAmount(reward, decimals),
        estimatedPayout: StakeService.toHumanAmount(payout, decimals),
        eligible: eligibleSet.has(`${utxo.txHash}#${utxo.outputIndex}`),
      };
    });

    return { boxes };
  }

  /**
   * 1. Validates all tokens (no duplicates, each has a positive computable raw amount).
   * 2. Builds one unsigned transaction with a separate `.pay.ToContract()` output per token,
   *    all sharing the same `staked_at` datum so eligibility checks remain consistent.
   * 3. Saves a single `created` DB record with `metadata.tokens` array.
   * 4. Returns `txCbor` + `transactionId`.
   */
  async buildStakeTx(
    userId: string,
    userAddress: string,
    tokens: { assetId: string; amount: number }[]
  ): Promise<BuildTxRes> {
    try {
      const { paymentCredential } = getAddressDetails(userAddress);
      if (!paymentCredential?.hash) throw new Error('Invalid user address.');
      const ownerHash = paymentCredential.hash;

      // Deduplicate
      const units = tokens.map(t => t.assetId.trim().toLowerCase());
      if (new Set(units).size !== units.length) {
        return { success: false, message: 'Duplicate assetId values are not allowed.' };
      }

      const currentTimeMs = Date.now();
      const datum = encodeStakeDatum({ owner: ownerHash, staked_at: BigInt(currentTimeMs) });

      // Resolve raw amounts with per-token decimals
      type TokenEntry = {
        unit: string;
        policyId: string;
        assetName: string;
        humanAmount: number;
        decimals: number;
        rawAmount: bigint;
      };
      const entries: TokenEntry[] = tokens.map(({ assetId, amount }) => {
        const unit = assetId.trim().toLowerCase();
        const decimals = this.getDecimalsForUnit(unit);
        const rawAmount = StakeService.toRawAmount(amount, decimals);
        if (rawAmount <= 0n) throw new Error(`Computed raw amount for ${unit} must be greater than 0.`);
        return {
          unit,
          policyId: unit.slice(0, 56),
          assetName: unit.slice(56),
          humanAmount: amount,
          decimals,
          rawAmount,
        };
      });

      const lucid = await this.getLucidForUser(userAddress);
      let txBuilder = lucid.newTx();

      for (const entry of entries) {
        txBuilder = txBuilder.pay.ToContract(
          this.contractAddress,
          { kind: 'inline', value: datum },
          { [entry.unit]: entry.rawAmount }
        );
      }

      const tx = await txBuilder.addSignerKey(ownerHash).complete();
      const unsignedTxCbor = tx.toCBOR();

      const saved = await this.transactionRepository.save({
        type: TransactionType.stake,
        status: TransactionStatus.created,
        user_id: userId,
        utxo_input: userAddress,
        utxo_output: this.contractAddress,
        amount: 0,
        metadata: {
          tokens: entries.map(e => ({
            assetId: e.unit,
            policyId: e.policyId,
            assetName: e.assetName,
            humanAmount: e.humanAmount,
            decimals: e.decimals,
            rawAmount: e.rawAmount.toString(),
          })),
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

      this.logger.log(
        `buildStakeTx: ${entries.length} token(s) staked for ${userAddress} — ` +
          entries.map(e => `${e.unit.slice(0, 10)}…=${e.rawAmount}`).join(', ')
      );

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
      // Return all lovelace locked in the consumed UTxOs back to the user.
      // Without this the ADA would flow to the admin change address instead.
      const lovelaceFromBoxes = eligibleBoxes.reduce((sum, u) => sum + (u.assets['lovelace'] ?? 0n), 0n);
      if (lovelaceFromBoxes > 0n) {
        payoutByUnit.set('lovelace', lovelaceFromBoxes);
      }

      this.logger.log(
        `buildUnstakeTx: ${eligibleBoxes.length} eligible UTxO(s) for ${userAddress} — ` +
          `deposit=${totalDepositAll}, reward=${totalRewardAll}, payout=${totalDepositAll + totalRewardAll}, lovelace=${lovelaceFromBoxes}`
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
      const tokensSummary = this.buildTokensSummary(processedBoxes);
      const saved = await this.transactionRepository.save({
        type: TransactionType.unstake,
        status: TransactionStatus.created,
        user_id: userId,
        utxo_input: this.contractAddress,
        utxo_output: userAddress,
        amount: 0,
        metadata: {
          utxos: eligibleBoxes.map(u => ({ txHash: u.txHash, outputIndex: u.outputIndex })),
          tokens: tokensSummary,
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
      // Track lovelace per unit so old-box ADA re-enters the new boxes, not admin change.
      const lovelaceByUnit = new Map<string, bigint>();
      for (const box of processedBoxes) {
        depositByUnit.set(box.unit, (depositByUnit.get(box.unit) ?? 0n) + box.deposit);
        rewardByUnit.set(box.unit, (rewardByUnit.get(box.unit) ?? 0n) + box.reward);
        lovelaceByUnit.set(box.unit, (lovelaceByUnit.get(box.unit) ?? 0n) + (box.utxo.assets['lovelace'] ?? 0n));
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
        const lovelace = lovelaceByUnit.get(unit) ?? 0n;
        txBuilder = txBuilder.pay.ToContract(
          this.contractAddress,
          { kind: 'inline', value: datum },
          lovelace > 0n ? { lovelace, [unit]: deposit } : { [unit]: deposit }
        );
      }

      // Reward tokens are sent to the user. Cardano requires a min-ADA alongside any
      // token output; Lucid calculates this automatically — admin wallet covers it.
      txBuilder = txBuilder.pay.ToAddress(userAddress, Object.fromEntries(rewardByUnit.entries()));
      const tx = await txBuilder.addSignerKey(ownerHash).complete();

      const unsignedTxCbor = tx.toCBOR();
      const tokensSummary = this.buildTokensSummary(processedBoxes);
      const saved = await this.transactionRepository.save({
        type: TransactionType.harvest,
        status: TransactionStatus.created,
        user_id: userId,
        utxo_input: this.contractAddress,
        utxo_output: userAddress,
        amount: 0,
        metadata: {
          utxos: eligibleBoxes.map(u => ({ txHash: u.txHash, outputIndex: u.outputIndex })),
          tokens: tokensSummary,
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
      // Track lovelace per unit so old-box ADA re-enters the new boxes, not admin change.
      const lovelaceByUnit = new Map<string, bigint>();
      for (const box of processedBoxes) {
        newAmountByUnit.set(box.unit, (newAmountByUnit.get(box.unit) ?? 0n) + box.payout);
        lovelaceByUnit.set(box.unit, (lovelaceByUnit.get(box.unit) ?? 0n) + (box.utxo.assets['lovelace'] ?? 0n));
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
        const lovelace = lovelaceByUnit.get(unit) ?? 0n;
        txBuilder = txBuilder.pay.ToContract(
          this.contractAddress,
          { kind: 'inline', value: datum },
          lovelace > 0n ? { lovelace, [unit]: newAmount } : { [unit]: newAmount }
        );
      }

      const tx = await txBuilder.addSignerKey(ownerHash).complete();

      const unsignedTxCbor = tx.toCBOR();
      const tokensSummary = this.buildTokensSummary(processedBoxes);
      const saved = await this.transactionRepository.save({
        type: TransactionType.compound,
        status: TransactionStatus.created,
        user_id: userId,
        utxo_input: this.contractAddress,
        utxo_output: this.contractAddress,
        amount: 0,
        metadata: {
          utxos: eligibleBoxes.map(u => ({ txHash: u.txHash, outputIndex: u.outputIndex })),
          tokens: tokensSummary,
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
