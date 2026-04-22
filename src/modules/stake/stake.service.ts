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
import { Repository } from 'typeorm';

import { BuildTxRes } from './dto/build-tx.res';
import { StakedBalanceRes, StakedBoxItem } from './dto/staked-balance.res';
import { SubmitStakeTxDto } from './dto/submit-stake-tx.dto';
import { SubmitTxRes } from './dto/submit-tx.res';
import { encodeStakeDatum, tryDecodeStakeDatum } from './stake-datum';

import { createLucidBlockfrostProvider, lucidNetworkFromCardanoEnv } from '@/common/cardano/blockfrost-lucid';
import { normalizeLucidCardanoError } from '@/common/cardano/lucid-error-normalizer';
import { StakingStatus, TokenStakingPosition, TokenType } from '@/database/tokenStakingPosition.entity';
import { Transaction } from '@/database/transaction.entity';
import { UtxoRefDto } from '@/modules/stake/dto/unstake-tokens.dto';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

/** Transaction types built from the admin wallet and requiring admin co-sign on submit. */
const ADMIN_SIGNED_TYPES = [TransactionType.unstake, TransactionType.harvest, TransactionType.compound];

// ---------------------------------------------------------------------------
// Module-level pure helpers
// ---------------------------------------------------------------------------

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function toRawAmount(amount: number, decimals: number): bigint {
  return BigInt(Math.round(amount * Math.pow(10, decimals)));
}

function toHumanAmount(raw: bigint, decimals: number): number {
  return Number(raw) / Math.pow(10, decimals);
}

function bigintToSafeNumber(value: bigint, label: string): number {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (value > max || value < -max) throw new Error(`${label} exceeds JS safe integer range`);
  return Number(value);
}

function formatError(error: unknown, fallback: string): string {
  return normalizeLucidCardanoError(error, fallback);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TokenMeta = { decimals: number; type: TokenType | null };
/** Processed stake box: on-chain UTxO + token unit + reward data + datum staked_at. */
type ProcessedBox = { utxo: UTxO; unit: string; deposit: bigint; reward: bigint; payout: bigint; staked_at: bigint };
type UnitAggregation = { deposit: bigint; reward: bigint; payout: bigint; lovelace: bigint };

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

// ---------------------------------------------------------------------------

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
  /** APY pre-scaled to 12 decimal places for bigint reward arithmetic. */
  private readonly APY_SCALED: bigint;
  /** Fallback decimals for unknown tokens. */
  private readonly TOKEN_DECIMALS = 4;
  /** unit (policyId + assetName hex, lowercase) → { decimals, type } */
  private readonly tokenRegistry: Map<string, TokenMeta>;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(TokenStakingPosition)
    private readonly tokenStakingPositionRepository: Repository<TokenStakingPosition>
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
    this.APY_SCALED = BigInt(Math.round(this.APY * 1e12));

    this.tokenRegistry = this.buildTokenRegistry();
  }

  // ---------------------------------------------------------------------------
  // Token registry
  // ---------------------------------------------------------------------------

  private buildTokenRegistry(): Map<string, TokenMeta> {
    const map = new Map<string, TokenMeta>();

    const vlrmPolicy = this.configService.get<string>('VLRM_POLICY_ID')?.toLowerCase();
    const vlrmName = this.configService.get<string>('VLRM_HEX_ASSET_NAME')?.toLowerCase() ?? '';
    const vlrmDecimals = parseInt(this.configService.get<string>('VLRM_DECIMALS') ?? '4', 10);
    if (vlrmPolicy) {
      map.set(`${vlrmPolicy}${vlrmName}`, {
        decimals: Number.isFinite(vlrmDecimals) ? vlrmDecimals : 4,
        type: TokenType.VLRM,
      });
    }

    const l4vaPolicy = this.configService.get<string>('L4VA_POLICY_ID')?.toLowerCase();
    const l4vaName = this.configService.get<string>('L4VA_ASSET_NAME')?.toLowerCase() ?? '';
    const l4vaDecimals = parseInt(this.configService.get<string>('L4VA_DECIMALS') ?? '3', 10);
    if (l4vaPolicy) {
      map.set(`${l4vaPolicy}${l4vaName}`, {
        decimals: Number.isFinite(l4vaDecimals) ? l4vaDecimals : 3,
        type: TokenType.L4VA,
      });
    }

    return map;
  }

  private getDecimalsForUnit(unit: string): number {
    return this.tokenRegistry.get(unit.toLowerCase())?.decimals ?? this.TOKEN_DECIMALS;
  }

  private getTokenTypeForUnit(unit: string): TokenType | null {
    return this.tokenRegistry.get(unit.toLowerCase())?.type ?? null;
  }

  /** Reverse lookup: TokenType → canonical unit string. */
  private getUnitForTokenType(tokenType: TokenType): string {
    for (const [unit, meta] of this.tokenRegistry) {
      if (meta.type === tokenType) return unit;
    }
    return '';
  }

  /**
   * Determines which TokenType corresponds to a given output index in a transaction's
   * metadata.tokens array. Works for both stake (uses 'assetId') and harvest/compound (uses 'unit').
   */
  private getTokenTypeAtOutputIndex(tx: Transaction, outputIndex: number): TokenType | null {
    const tokens: Array<{ assetId?: string; unit?: string }> = Array.isArray(tx.metadata?.tokens)
      ? tx.metadata.tokens
      : [];
    const entry = tokens[outputIndex];
    if (!entry) return null;
    const rawUnit = String(entry.assetId ?? entry.unit ?? '')
      .trim()
      .toLowerCase();
    return this.getTokenTypeForUnit(rawUnit);
  }

  // ---------------------------------------------------------------------------
  // Lucid / address helpers
  // ---------------------------------------------------------------------------

  private async createLucid(): Promise<LucidEvolution> {
    return Lucid(createLucidBlockfrostProvider(this.blockfrostProjectId, this.network), this.network);
  }

  private async getLucidFor(address: string): Promise<LucidEvolution> {
    const lucid = await this.createLucid();
    const utxos = await lucid.utxosAt(address);
    lucid.selectWallet.fromAddress(address, utxos);
    return lucid;
  }

  /** Extracts the payment credential hash from a Cardano address. */
  private extractOwnerHash(userAddress: string): string {
    const { paymentCredential } = getAddressDetails(userAddress);
    if (!paymentCredential?.hash) throw new Error('Invalid user address.');
    return paymentCredential.hash;
  }

  // ---------------------------------------------------------------------------
  // Transaction metadata / build helpers
  // ---------------------------------------------------------------------------

  private buildBaseTxMetadata(unsignedTxCbor: string): {
    unsignedTxCborHash: string;
    contractAddress: string;
    referenceScript: { txHash: string; outputIndex: number };
    cardanoNetwork: string;
  } {
    return {
      unsignedTxCborHash: sha256Hex(unsignedTxCbor),
      contractAddress: this.contractAddress,
      referenceScript: { txHash: this.referenceScriptTxHash, outputIndex: this.referenceScriptIndex },
      cardanoNetwork: this.isMainnet ? 'mainnet' : 'preprod',
    };
  }

  /**
   * Groups processed boxes by token unit and builds a per-token summary.
   * The order of the output array matches the order outputs are added to the tx builder,
   * so index 0 = contract output index 0, index 1 = contract output index 1, etc.
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
        depositAmount: toHumanAmount(amounts.deposit, decimals),
        rewardAmount: toHumanAmount(amounts.reward, decimals),
        payoutAmount: toHumanAmount(amounts.payout, decimals),
      };
    });
  }

  /** Aggregates processed boxes by unit, summing deposit, reward, payout, and lovelace. */
  private aggregateByUnit(boxes: ProcessedBox[]): Map<string, UnitAggregation> {
    const map = new Map<string, UnitAggregation>();
    for (const box of boxes) {
      const acc = map.get(box.unit) ?? { deposit: 0n, reward: 0n, payout: 0n, lovelace: 0n };
      acc.deposit += box.deposit;
      acc.reward += box.reward;
      acc.payout += box.payout;
      acc.lovelace += box.utxo.assets['lovelace'] ?? 0n;
      map.set(box.unit, acc);
    }
    return map;
  }

  // ---------------------------------------------------------------------------
  // Staking position tracking — one DB record per on-chain box
  // ---------------------------------------------------------------------------

  /**
   * Called when a stake transaction is confirmed.
   * Creates one position per token. staked_at and utxo_tx_hash are intentionally
   * NOT stored here — they are read from the linked stake_transaction when needed.
   */
  private async onStakeConfirmed(transaction: Transaction): Promise<void> {
    const tokens: Array<{ assetId?: string; rawAmount?: string }> = Array.isArray(transaction.metadata?.tokens)
      ? transaction.metadata.tokens
      : [];

    for (const t of tokens) {
      const unit = String(t.assetId ?? '')
        .trim()
        .toLowerCase();
      const rawAmount = BigInt(String(t.rawAmount ?? '0'));
      const tokenType = this.getTokenTypeForUnit(unit);
      if (!unit || rawAmount <= 0n || !tokenType) continue;

      await this.tokenStakingPositionRepository.save({
        user_id: transaction.user_id!,
        token_type: tokenType,
        amount: bigintToSafeNumber(rawAmount, 'staking position amount'),
        status: StakingStatus.ACTIVE,
        stake_tx_id: transaction.id,
      });
    }
  }

  /**
   * Closes existing ACTIVE positions for the UTxO refs listed in metadata.utxos.
   * Looks up which token_type each UTxO corresponds to by reading the creator
   * transaction's metadata.tokens order (index = Cardano output index).
   */
  private async closePositionsByUtxoRefs(
    userId: string,
    txId: string,
    refs: Array<{ txHash: string; outputIndex: number }>
  ): Promise<void> {
    for (const ref of refs) {
      if (!ref.txHash) continue;

      // The UTxO's txHash is the hash of the tx that created that output (stake/harvest/compound).
      const creatorTx = await this.transactionRepository.findOne({
        where: { tx_hash: ref.txHash },
        select: ['id', 'metadata'],
      });
      if (!creatorTx) {
        this.logger.warn(`closePositionsByUtxoRefs: no tx found with hash=${ref.txHash}`);
        continue;
      }

      const tokenType = this.getTokenTypeAtOutputIndex(creatorTx, ref.outputIndex);
      if (!tokenType) {
        this.logger.warn(`closePositionsByUtxoRefs: cannot determine token type for ${ref.txHash}#${ref.outputIndex}`);
        continue;
      }

      const position = await this.tokenStakingPositionRepository.findOne({
        where: { stake_tx_id: creatorTx.id, token_type: tokenType, user_id: userId, status: StakingStatus.ACTIVE },
      });
      if (!position) {
        this.logger.warn(
          `closePositionsByUtxoRefs: no ACTIVE position for stake_tx=${creatorTx.id} token=${tokenType} user=${userId}`
        );
        continue;
      }

      await this.tokenStakingPositionRepository.save({
        ...position,
        status: StakingStatus.CLOSED,
        unstake_tx_id: txId,
      });
    }
  }

  /**
   * Called when a harvest or compound transaction is confirmed.
   * Closes old positions (consumed boxes) and creates new ones for the re-locked outputs.
   */
  private async onHarvestOrCompoundConfirmed(
    transaction: Transaction,
    txType: TransactionType.harvest | TransactionType.compound
  ): Promise<void> {
    const userId = transaction.user_id!;
    const meta = transaction.metadata ?? {};

    const consumedRefs: Array<{ txHash: string; outputIndex: number }> = Array.isArray(meta.utxos) ? meta.utxos : [];
    await this.closePositionsByUtxoRefs(userId, transaction.id, consumedRefs);

    // Create new positions for the re-locked outputs.
    // metadata.tokens order matches the contract output order (index 0, 1, 2…).
    const tokensSummary: Array<{ unit?: string; rawDeposit?: string; rawPayout?: string }> = Array.isArray(meta.tokens)
      ? meta.tokens
      : [];

    for (const t of tokensSummary) {
      const unit = String(t.unit ?? '')
        .trim()
        .toLowerCase();
      const tokenType = this.getTokenTypeForUnit(unit);
      if (!unit || !tokenType) continue;

      // Harvest re-locks deposit only; compound re-locks deposit + reward (payout).
      const rawAmount =
        txType === TransactionType.compound ? BigInt(String(t.rawPayout ?? '0')) : BigInt(String(t.rawDeposit ?? '0'));
      if (rawAmount <= 0n) continue;

      await this.tokenStakingPositionRepository.save({
        user_id: userId,
        token_type: tokenType,
        amount: bigintToSafeNumber(rawAmount, 'staking position amount'),
        status: StakingStatus.ACTIVE,
        stake_tx_id: transaction.id,
      });
    }
  }

  /**
   * Dispatches to the appropriate position handler after a transaction is confirmed.
   */
  private async syncPositionsOnConfirm(transaction: Transaction): Promise<void> {
    const { user_id: userId, type: txType } = transaction;
    if (!userId || !txType) return;

    switch (txType) {
      case TransactionType.stake:
        await this.onStakeConfirmed(transaction);
        break;

      case TransactionType.unstake: {
        const refs: Array<{ txHash: string; outputIndex: number }> = Array.isArray(transaction.metadata?.utxos)
          ? transaction.metadata.utxos
          : [];
        await this.closePositionsByUtxoRefs(userId, transaction.id, refs);
        break;
      }

      case TransactionType.harvest:
        await this.onHarvestOrCompoundConfirmed(transaction, TransactionType.harvest);
        break;

      case TransactionType.compound:
        await this.onHarvestOrCompoundConfirmed(transaction, TransactionType.compound);
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // On-chain helpers
  // ---------------------------------------------------------------------------

  private calculateRewardForUtxo(
    unit: string,
    utxo: UTxO
  ): { deposit: bigint; reward: bigint; payout: bigint; staked_at: bigint } {
    const MS_IN_YEAR = 365n * 24n * 60n * 60n * 1000n;
    const APY_SCALE = 10n ** 12n;

    const amount = utxo.assets[unit] ?? 0n;
    const decoded = tryDecodeStakeDatum(utxo.datum!);
    const staked_at = decoded!.staked_at;
    const elapsed = BigInt(Math.max(0, Date.now() - Number(staked_at)));
    const reward = (amount * this.APY_SCALED * elapsed) / (MS_IN_YEAR * APY_SCALE);
    return { deposit: amount, reward, payout: amount + reward, staked_at };
  }

  /**
   * Filters candidate UTxOs to only those whose on-chain staked_at matches an
   * ACTIVE position's stake transaction staked_at (the source of truth for eligibility).
   */
  private async getUnstakeEligibleBoxes(
    userId: string,
    userAddress: string,
    candidateBoxes: UTxO[]
  ): Promise<{ ok: true; boxes: UTxO[] } | { ok: false; message: string }> {
    const positions = await this.tokenStakingPositionRepository.find({
      where: { user_id: userId, status: StakingStatus.ACTIVE },
      relations: ['stake_transaction'],
    });

    const trustedStakedAt = new Set(
      positions.map(p => Number(p.stake_transaction?.metadata?.staked_at)).filter(v => Number.isFinite(v) && v > 0)
    );

    const verifiedBoxes = candidateBoxes.filter(utxo => {
      const decoded = tryDecodeStakeDatum(utxo.datum!);
      const stakedAt = Number(decoded?.staked_at);

      if (!trustedStakedAt.has(stakedAt)) {
        this.logger.warn(
          `getUnstakeEligibleBoxes: rejecting UTxO ${utxo.txHash}#${utxo.outputIndex} ` +
            `with unverified staked_at=${stakedAt} for user ${userId} — no matching ACTIVE position`
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
      return { ok: false, message: 'No eligible UTxOs found. All positions were unverified.' } as const;
    }

    return { ok: true, boxes: verifiedBoxes } as const;
  }

  /**
   * Fetches only the requested UTxO refs, verifies they are at the contract
   * address and belong to this user.
   */
  private async resolveRequestedBoxes(
    lucid: LucidEvolution,
    userAddress: string,
    ownerHash: string,
    utxoRefs: UtxoRefDto[]
  ): Promise<{ ok: true; boxes: UTxO[] } | { ok: false; message: string }> {
    const refKey = (txHash: string, outputIndex: number): string => `${txHash}#${outputIndex}`;

    const uniqueRefs = Array.from(new Map(utxoRefs.map(r => [refKey(r.txHash, r.outputIndex), r])).values());

    const fetched = await lucid.utxosByOutRef(uniqueRefs.map(r => ({ txHash: r.txHash, outputIndex: r.outputIndex })));

    const requestedBoxes = fetched.filter(utxo => {
      if (utxo.address !== this.contractAddress) return false;
      if (!utxo.datum) return false;
      const decoded = tryDecodeStakeDatum(utxo.datum);
      return decoded !== null && decoded.owner === ownerHash;
    });

    if (requestedBoxes.length === 0) {
      return { ok: false, message: 'None of the requested UTxOs were found at the contract for your address.' };
    }

    if (requestedBoxes.length < uniqueRefs.length) {
      this.logger.warn(
        `resolveRequestedBoxes: ${uniqueRefs.length - requestedBoxes.length} requested UTxO(s) not found on-chain for ${userAddress}`
      );
    }

    return { ok: true, boxes: requestedBoxes };
  }

  /**
   * Shared setup for unstake, harvest, and compound.
   * Initialises Lucid, verifies ownership, filters eligible boxes, loads the reference
   * script, and pre-computes per-box reward data.
   */
  private async prepareAdminTxData(
    userId: string,
    userAddress: string,
    utxoRefs: UtxoRefDto[]
  ): Promise<AdminTxData | { ok: false; message: string }> {
    const lucid = await this.getLucidFor(this.adminAddress);
    const ownerHash = this.extractOwnerHash(userAddress);

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
      const { deposit, reward, payout, staked_at } = this.calculateRewardForUtxo(unit, utxo);
      totalDepositAll += deposit;
      totalRewardAll += reward;
      processedBoxes.push({ utxo, unit, deposit, reward, payout, staked_at });
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

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Returns active staking positions from the database with estimated rewards.
   * staked_at and utxo_tx_hash are read from the linked stake_transaction.
   * Does not require an on-chain call.
   */
  async getStakedBalanceFromDb(userId: string): Promise<StakedBalanceRes> {
    const MS_IN_YEAR = 365n * 24n * 60n * 60n * 1000n;
    const APY_SCALE = 10n ** 12n;

    const positions = await this.tokenStakingPositionRepository.find({
      where: { user_id: userId, status: StakingStatus.ACTIVE },
      relations: ['stake_transaction'],
      order: { created_at: 'ASC' },
    });

    const boxes: StakedBoxItem[] = positions
      .map(pos => {
        const unit = this.getUnitForTokenType(pos.token_type);
        if (!unit) return null;

        const txMeta = pos.stake_transaction?.metadata ?? {};
        const stakedAt = Number(txMeta.staked_at ?? 0);
        if (stakedAt <= 0) return null;

        // Output index = position of this token_type in the stake_transaction's metadata.tokens
        const tokens: Array<{ assetId?: string; unit?: string }> = Array.isArray(txMeta.tokens) ? txMeta.tokens : [];
        const outputIndex = tokens.findIndex(t => {
          const u = String(t.assetId ?? t.unit ?? '')
            .trim()
            .toLowerCase();
          return this.getTokenTypeForUnit(u) === pos.token_type;
        });

        const txHash = pos.stake_transaction?.tx_hash ?? '';

        const decimals = this.getDecimalsForUnit(unit);
        const amount = BigInt(pos.amount);
        const elapsed = BigInt(Math.max(0, Date.now() - stakedAt));
        const reward = (amount * this.APY_SCALED * elapsed) / (MS_IN_YEAR * APY_SCALE);
        const payout = amount + reward;

        return {
          txHash,
          outputIndex: outputIndex >= 0 ? outputIndex : 0,
          unit,
          policyId: unit.slice(0, 56),
          stakedAmount: toHumanAmount(amount, decimals),
          stakedAt,
          estimatedReward: toHumanAmount(reward, decimals),
          estimatedPayout: toHumanAmount(payout, decimals),
          eligible: true,
        } satisfies StakedBoxItem;
      })
      .filter((b): b is NonNullable<typeof b> => b !== null);

    return { boxes };
  }

  /**
   * Builds one unsigned stake transaction with a separate output per token.
   * All outputs share the same staked_at datum timestamp.
   */
  async buildStakeTx(
    userId: string,
    userAddress: string,
    tokens: { assetId: string; amount: number }[]
  ): Promise<BuildTxRes> {
    try {
      const ownerHash = this.extractOwnerHash(userAddress);

      const units = tokens.map(t => t.assetId.trim().toLowerCase());
      if (new Set(units).size !== units.length) {
        return { success: false, message: 'Duplicate assetId values are not allowed.' };
      }
      const unsupportedUnits = units.filter(unit => this.getTokenTypeForUnit(unit) === null);
      if (unsupportedUnits.length > 0) {
        return {
          success: false,
          message: `Unsupported staking token(s). Only VLRM and L4VA can be staked.`,
        };
      }

      const currentTimeMs = Date.now();
      const datum = encodeStakeDatum({ owner: ownerHash, staked_at: BigInt(currentTimeMs) });

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
        const rawAmount = toRawAmount(amount, decimals);
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

      const lucid = await this.getLucidFor(userAddress);
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
          ...this.buildBaseTxMetadata(unsignedTxCbor),
        },
      });

      this.logger.log(
        `[buildStakeTx] tokens=${entries.length} user=${userAddress} — ` +
          entries.map(e => `${e.unit.slice(0, 10)}…=${e.rawAmount}`).join(', ')
      );

      return { success: true, txCbor: unsignedTxCbor, transactionId: saved.id };
    } catch (error: unknown) {
      this.logger.error('buildStakeTx failed', error instanceof Error ? error.stack : String(error));
      return { success: false, message: formatError(error, 'buildStakeTx failed') };
    }
  }

  /**
   * Unstake: collect selected boxes, send full payout (deposit + reward) to the user.
   */
  async buildUnstakeTx(userId: string, userAddress: string, utxoRefs: UtxoRefDto[]): Promise<BuildTxRes> {
    try {
      const prep = await this.prepareAdminTxData(userId, userAddress, utxoRefs);
      if (prep.ok === false) return { success: false, message: prep.message };

      const { lucid, ownerHash, referenceUtxo, eligibleBoxes, processedBoxes, totalDepositAll, totalRewardAll } = prep;

      const aggByUnit = this.aggregateByUnit(processedBoxes);

      const payoutByUnit = new Map<string, bigint>();
      for (const [unit, agg] of aggByUnit) {
        payoutByUnit.set(unit, agg.payout);
        if (agg.lovelace > 0n) payoutByUnit.set('lovelace', (payoutByUnit.get('lovelace') ?? 0n) + agg.lovelace);
      }

      this.logger.log(
        `[buildUnstakeTx] boxes=${eligibleBoxes.length} user=${userAddress} ` +
          `deposit=${totalDepositAll} reward=${totalRewardAll} payout=${totalDepositAll + totalRewardAll}`
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
        amount: 0,
        metadata: {
          utxos: eligibleBoxes.map(u => ({ txHash: u.txHash, outputIndex: u.outputIndex })),
          tokens: this.buildTokensSummary(processedBoxes),
          utxoCount: eligibleBoxes.length,
          ...this.buildBaseTxMetadata(unsignedTxCbor),
        },
      });

      return { success: true, txCbor: unsignedTxCbor, transactionId: saved.id };
    } catch (error: unknown) {
      this.logger.error('buildUnstakeTx failed', error instanceof Error ? error.stack : String(error));
      return { success: false, message: formatError(error, 'buildUnstakeTx failed') };
    }
  }

  /**
   * Harvest: collect selected boxes, send rewards to the user, re-lock deposits
   * in new boxes with staked_at = now (resetting the reward timer).
   */
  async buildHarvestTx(userId: string, userAddress: string, utxoRefs: UtxoRefDto[]): Promise<BuildTxRes> {
    try {
      const prep = await this.prepareAdminTxData(userId, userAddress, utxoRefs);
      if (prep.ok === false) return { success: false, message: prep.message };

      const { lucid, ownerHash, referenceUtxo, eligibleBoxes, processedBoxes, totalDepositAll, totalRewardAll } = prep;

      const aggByUnit = this.aggregateByUnit(processedBoxes);

      this.logger.log(
        `[buildHarvestTx] boxes=${eligibleBoxes.length} user=${userAddress} ` +
          `deposit=${totalDepositAll} reward=${totalRewardAll}`
      );

      const now = Date.now();
      const redeemer = Data.to(new Constr(0, []));
      let txBuilder = lucid.newTx().readFrom([referenceUtxo]).collectFrom(eligibleBoxes, redeemer);

      const rewardByUnit = new Map<string, bigint>();
      for (const [unit, agg] of aggByUnit) {
        const datum = encodeStakeDatum({ owner: ownerHash, staked_at: BigInt(now) });
        txBuilder = txBuilder.pay.ToContract(
          this.contractAddress,
          { kind: 'inline', value: datum },
          agg.lovelace > 0n ? { lovelace: agg.lovelace, [unit]: agg.deposit } : { [unit]: agg.deposit }
        );
        rewardByUnit.set(unit, agg.reward);
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
        amount: 0,
        metadata: {
          utxos: eligibleBoxes.map(u => ({ txHash: u.txHash, outputIndex: u.outputIndex })),
          tokens: this.buildTokensSummary(processedBoxes),
          staked_at: now,
          utxoCount: eligibleBoxes.length,
          ...this.buildBaseTxMetadata(unsignedTxCbor),
        },
      });

      return { success: true, txCbor: unsignedTxCbor, transactionId: saved.id };
    } catch (error: unknown) {
      this.logger.error('buildHarvestTx failed', error instanceof Error ? error.stack : String(error));
      return { success: false, message: formatError(error, 'buildHarvestTx failed') };
    }
  }

  /**
   * Compound: collect selected boxes, re-lock deposit + reward in new boxes with staked_at = now.
   */
  async buildCompoundTx(userId: string, userAddress: string, utxoRefs: UtxoRefDto[]): Promise<BuildTxRes> {
    try {
      const prep = await this.prepareAdminTxData(userId, userAddress, utxoRefs);
      if (prep.ok === false) return { success: false, message: prep.message };

      const { lucid, ownerHash, referenceUtxo, eligibleBoxes, processedBoxes, totalDepositAll, totalRewardAll } = prep;

      const aggByUnit = this.aggregateByUnit(processedBoxes);

      this.logger.log(
        `[buildCompoundTx] boxes=${eligibleBoxes.length} user=${userAddress} ` +
          `deposit=${totalDepositAll} reward=${totalRewardAll} newDeposit=${totalDepositAll + totalRewardAll}`
      );

      const now = Date.now();
      const redeemer = Data.to(new Constr(0, []));
      let txBuilder = lucid.newTx().readFrom([referenceUtxo]).collectFrom(eligibleBoxes, redeemer);

      for (const [unit, agg] of aggByUnit) {
        const datum = encodeStakeDatum({ owner: ownerHash, staked_at: BigInt(now) });
        txBuilder = txBuilder.pay.ToContract(
          this.contractAddress,
          { kind: 'inline', value: datum },
          agg.lovelace > 0n ? { lovelace: agg.lovelace, [unit]: agg.payout } : { [unit]: agg.payout }
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
        amount: 0,
        metadata: {
          utxos: eligibleBoxes.map(u => ({ txHash: u.txHash, outputIndex: u.outputIndex })),
          tokens: this.buildTokensSummary(processedBoxes),
          staked_at: now,
          utxoCount: eligibleBoxes.length,
          ...this.buildBaseTxMetadata(unsignedTxCbor),
        },
      });

      return { success: true, txCbor: unsignedTxCbor, transactionId: saved.id };
    } catch (error: unknown) {
      this.logger.error('buildCompoundTx failed', error instanceof Error ? error.stack : String(error));
      return { success: false, message: formatError(error, 'buildCompoundTx failed') };
    }
  }

  /**
   * Assembles witnesses and submits a signed transaction.
   * Works for stake, unstake, harvest, and compound.
   * After confirmation, syncs the staking positions table.
   */
  async submitTransaction(userId: string, dto: SubmitStakeTxDto): Promise<SubmitTxRes> {
    const { txCbor, signature, transactionId } = dto;

    const transaction = await this.transactionRepository.findOne({ where: { id: transactionId, user_id: userId } });
    if (!transaction) return { success: false, message: 'Transaction not found.' };

    try {
      const isAdminSigned = ADMIN_SIGNED_TYPES.includes(transaction.type as TransactionType);

      const expectedHash = transaction.metadata?.unsignedTxCborHash;
      if (typeof expectedHash === 'string' && expectedHash.length > 0) {
        if (sha256Hex(txCbor) !== expectedHash) {
          return { success: false, message: 'Unsigned transaction mismatch. Please rebuild and try again.' };
        }
      } else if (isAdminSigned) {
        return { success: false, message: 'Server cannot verify unsigned transaction. Please rebuild and try again.' };
      }

      const updateResult = await this.transactionRepository.update(
        { id: transactionId, user_id: userId, status: TransactionStatus.created },
        { status: TransactionStatus.pending }
      );

      if (!updateResult.affected) {
        return { success: false, message: 'Transaction not found, already processing, or already submitted.' };
      }

      const lucid = await this.getLucidFor(isAdminSigned ? this.adminAddress : transaction.utxo_input);
      const signBuilder = lucid.fromTx(txCbor).assemble([signature]);

      const signedTx = isAdminSigned
        ? await signBuilder.sign.withPrivateKey(this.adminSKey).complete()
        : await signBuilder.complete();

      const txHash = await signedTx.submit();

      await this.transactionRepository.update(
        { id: transactionId },
        { tx_hash: txHash, status: TransactionStatus.confirmed }
      );

      // Reload transaction to have the confirmed tx_hash available for position tracking.
      const confirmedTransaction = await this.transactionRepository.findOne({ where: { id: transactionId } });
      await this.syncPositionsOnConfirm(confirmedTransaction!).catch(err =>
        this.logger.error('Failed to sync staking positions', err)
      );

      this.logger.log(`${transaction.type} transaction submitted! Hash: ${txHash}, dbId: ${transactionId}`);
      return { success: true, txHash, transactionId };
    } catch (error: unknown) {
      this.logger.error('submitTransaction failed', error instanceof Error ? error.stack : String(error));

      await this.transactionRepository
        .update({ id: transactionId }, { status: TransactionStatus.failed })
        .catch(err => this.logger.error('Failed to mark transaction as failed', err));

      return { success: false, message: formatError(error, 'Submit failed') };
    }
  }
}
