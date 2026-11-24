import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Address, FixedTransaction, PrivateKey } from '@emurgo/cardano-serialization-lib-nodejs';
import { Lucid, type MintingPolicy } from '@lucid-evolution/lucid';
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import Redis from 'ioredis';

import {
  BuybackSplit,
  BuybackSplitBps,
  baseToDisplay,
  checkQuote,
  displayToBase,
  planDistribution,
  planSwapAmount,
  validateSplit,
} from './cardano-buyback.planner';

import { createLucidBlockfrostProvider, lucidNetworkFromCardanoEnv } from '@/common/cardano/blockfrost-lucid';
import { getBurnWallet } from '@/common/cardano/burn-wallet';
import { L4VA_BURN_REDEEMER, findL4vaPolicy } from '@/common/cardano/l4va-token-policy';
import { DexHunterService } from '@/modules/dexhunter/dexhunter.service';
import { SystemSettingsService } from '@/modules/globals/system-settings/system-settings.service';
import { REDIS_CLIENT } from '@/modules/redis/redis.module';
import { TransactionsService } from '@/modules/vaults/processing-tx/offchain-tx/transactions.service';
import { BlockchainService } from '@/modules/vaults/processing-tx/onchain/blockchain.service';
import { getUtxosExtract } from '@/modules/vaults/processing-tx/onchain/utils/lib';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

const LOCK_KEY = 'cardano-buyback:cycle:lock';
const LOCK_TTL_SECONDS = 600;
const FUND_LOCK_KEY = 'cardano-buyback:fund:lock';
/** Hash of the last submitted swap/distribution. Blockfrost does not see the
 *  mempool, so until it confirms the wallet's UTxOs look unspent; a cycle that
 *  ran before then would double-spend them. Expires so a dropped tx unblocks. */
const PENDING_TX_KEY = 'cardano-buyback:pending-tx';
const PENDING_TX_TTL_SECONDS = 3600;
/** Headroom over the funded amount for fee and min-change when picking UTxOs. */
const FUND_FEE_HEADROOM_LOVELACE = 2_000_000n;

export type BuybackCycleResult =
  | { action: 'skipped'; reason: string }
  | { action: 'idle'; reason: string }
  | { action: 'distributed'; txHash: string; split: Record<keyof BuybackSplit, string> }
  | { action: 'swapped'; txHash: string; lovelaceIn: string; minL4vaOut: string };

/**
 * Cardano L4VA buyback (counterpart of the EVM BuybackExecutor).
 *
 * A dedicated buyback wallet holds ADA from protocol fees (moved in with
 * `fund`). Each cycle performs at most one on-chain action, so the second
 * never spends UTxOs the first left in the mempool:
 *
 *   1. Distribute — if the wallet holds L4VA (filled swap orders), burn 25%,
 *      send 25% to the L4VA treasury and 50% to operations.
 *   2. Otherwise swap — ADA above the reserve, capped per execution, into L4VA
 *      via DexHunter. The order is filled asynchronously by a batcher; the
 *      L4VA lands back in the wallet and is distributed on a later cycle.
 *
 * The burn is a negative mint through the deployed L4VA policy, which lets any
 * holder burn (src/scripts/cardano/deployments). On testnet, for a policy that
 * is not one of our deployments (older test tokens), the burn share goes to the
 * protocol burn wallet instead; mainnet refuses to run without the real policy.
 *
 * The L4VA token is configured with its own CARDANO_BUYBACK_L4VA_* variables,
 * not the shared L4VA_POLICY_ID / L4VA_DECIMALS, so another module's legacy
 * token can never become the buyback target.
 */
@Injectable()
export class CardanoBuybackService {
  private readonly logger = new Logger(CardanoBuybackService.name);

  private notConfiguredWarned = false;
  /** Invalid config disables the buyback instead of failing app startup. */
  private configError: string | null = null;
  private readonly isMainnet: boolean;
  private readonly blockfrost: BlockFrostAPI;
  private readonly blockfrostProjectId: string;

  private l4vaPolicyId: string;
  private l4vaAssetName: string;
  private l4vaDecimals: number;

  private buybackAddress: string;
  private buybackSKey: string;
  private treasuryAddress: string;
  private opsAddress: string;
  private burnAddress: string;
  private burnPolicy: MintingPolicy | null;

  private adminAddress: string;
  private adminSKey: string;
  private adminHash: string;

  private split: BuybackSplitBps;
  private reserveLovelace: bigint;
  private minSwapLovelace: bigint;
  private maxSwapLovelace: bigint;
  private slippagePct: number;
  private maxPriceImpactBps: bigint;
  private minL4vaPerAda: bigint;
  private minDistribute: bigint;

  constructor(
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService,
    private readonly dexHunterService: DexHunterService,
    private readonly transactionsService: TransactionsService,
    private readonly systemSettingsService: SystemSettingsService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis
  ) {
    const get = (key: string): string | undefined =>
      this.configService.get<string>(key)?.toString().trim() || undefined;
    const big = (key: string, fallback: bigint): bigint => {
      const raw = get(key);
      if (!raw) return fallback;
      if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a non-negative integer, got "${raw}"`);
      return BigInt(raw);
    };

    this.isMainnet = get('CARDANO_NETWORK') === 'mainnet';
    this.blockfrostProjectId = get('BLOCKFROST_API_KEY');
    this.blockfrost = new BlockFrostAPI({ projectId: this.blockfrostProjectId });

    try {
      this.loadConfig(get, big);
    } catch (error: any) {
      this.configError = error.message;
      this.logger.error(`Cardano buyback disabled, invalid config: ${error.message}`);
    }
  }

  private loadConfig(get: (key: string) => string | undefined, big: (key: string, fallback: bigint) => bigint): void {
    this.l4vaPolicyId = get('CARDANO_BUYBACK_L4VA_POLICY_ID')?.toLowerCase() ?? '';
    this.l4vaAssetName = get('CARDANO_BUYBACK_L4VA_ASSET_NAME')?.toLowerCase() ?? '';
    const decimals = get('CARDANO_BUYBACK_L4VA_DECIMALS');
    if (decimals !== undefined && !/^\d+$/.test(decimals)) {
      throw new Error(`CARDANO_BUYBACK_L4VA_DECIMALS must be an integer, got "${decimals}"`);
    }
    this.l4vaDecimals = decimals === undefined ? NaN : Number(decimals);

    this.buybackAddress = get('CARDANO_BUYBACK_ADDRESS');
    this.buybackSKey = get('CARDANO_BUYBACK_S_KEY');
    this.treasuryAddress = get('CARDANO_BUYBACK_TREASURY_ADDRESS') ?? get('L4VA_TREASURY_ADDRESS');
    this.opsAddress = get('CARDANO_BUYBACK_OPS_ADDRESS');
    this.burnAddress = get('CARDANO_BUYBACK_BURN_ADDRESS') ?? getBurnWallet(this.isMainnet);
    this.burnPolicy = this.l4vaPolicyId ? findL4vaPolicy(this.l4vaPolicyId) : null;
    if (this.isMainnet && this.l4vaPolicyId && !this.burnPolicy) {
      throw new Error(
        `CARDANO_BUYBACK_L4VA_POLICY_ID ${this.l4vaPolicyId} is not a deployed L4VA policy; mainnet requires on-chain burn`
      );
    }

    this.adminAddress = get('ADMIN_ADDRESS');
    this.adminSKey = get('ADMIN_S_KEY');
    this.adminHash = get('ADMIN_KEY_HASH');

    this.split = {
      burnBps: big('CARDANO_BUYBACK_BURN_BPS', 2_500n),
      treasuryBps: big('CARDANO_BUYBACK_TREASURY_BPS', 2_500n),
    };
    validateSplit(this.split);

    this.reserveLovelace = big('CARDANO_BUYBACK_RESERVE_LOVELACE', 10_000_000n);
    this.minSwapLovelace = big('CARDANO_BUYBACK_MIN_SWAP_LOVELACE', 50_000_000n);
    this.maxSwapLovelace = big('CARDANO_BUYBACK_MAX_SWAP_LOVELACE', 1_000_000_000n);
    this.slippagePct = Number(get('CARDANO_BUYBACK_SLIPPAGE_PCT') ?? 1);
    this.maxPriceImpactBps = big('CARDANO_BUYBACK_MAX_PRICE_IMPACT_BPS', 300n);
    this.minL4vaPerAda = big('CARDANO_BUYBACK_MIN_L4VA_PER_ADA', 0n);
    this.minDistribute = big(
      'CARDANO_BUYBACK_MIN_DISTRIBUTE',
      Number.isInteger(this.l4vaDecimals) ? 10n ** BigInt(this.l4vaDecimals) : 1n
    );
    if (this.isMainnet && this.minL4vaPerAda === 0n) {
      throw new Error('CARDANO_BUYBACK_MIN_L4VA_PER_ADA must be set on mainnet (price floor)');
    }
  }

  private get l4vaUnit(): string {
    return `${this.l4vaPolicyId}${this.l4vaAssetName}`;
  }

  private get network(): 'mainnet' | 'preprod' {
    return this.isMainnet ? 'mainnet' : 'preprod';
  }

  private missingConfig(): string[] {
    if (this.configError) return [this.configError];
    return Object.entries({
      CARDANO_BUYBACK_L4VA_POLICY_ID: this.l4vaPolicyId,
      CARDANO_BUYBACK_L4VA_DECIMALS: Number.isInteger(this.l4vaDecimals) ? 'set' : '',
      CARDANO_BUYBACK_ADDRESS: this.buybackAddress,
      CARDANO_BUYBACK_S_KEY: this.buybackSKey,
      'CARDANO_BUYBACK_TREASURY_ADDRESS (or L4VA_TREASURY_ADDRESS)': this.treasuryAddress,
      CARDANO_BUYBACK_OPS_ADDRESS: this.opsAddress,
    })
      .filter(([, value]) => !value)
      .map(([key]) => key);
  }

  private assertConfigured(): void {
    const missing = this.missingConfig();
    if (missing.length > 0) {
      throw new BadRequestException(`Cardano buyback not configured: missing ${missing.join(', ')}`);
    }
  }

  private async getBalances(address: string): Promise<{ lovelace: bigint; l4va: bigint }> {
    try {
      const info = await this.blockfrost.addresses(address);
      const byUnit = new Map((info.amount ?? []).map(a => [a.unit.toLowerCase(), BigInt(a.quantity)]));
      return { lovelace: byUnit.get('lovelace') ?? 0n, l4va: byUnit.get(this.l4vaUnit) ?? 0n };
    } catch (error: any) {
      // Blockfrost 404s for an address that has never received funds.
      if (error?.status_code === 404) return { lovelace: 0n, l4va: 0n };
      throw error;
    }
  }

  /** Balances, config and what the next cycle would do. Read-only. */
  async getStatus(): Promise<Record<string, unknown>> {
    const missing = this.missingConfig();
    if (missing.length > 0) return { configured: false, missing };
    const balances = await this.getBalances(this.buybackAddress);
    const distribution = planDistribution(balances.l4va, this.minDistribute, this.split);
    const swapLovelace = distribution
      ? null
      : planSwapAmount({
          lovelaceBalance: balances.lovelace,
          reserveLovelace: this.reserveLovelace,
          minSwapLovelace: this.minSwapLovelace,
          maxSwapLovelace: this.maxSwapLovelace,
        });

    return {
      configured: true,
      pendingTx: await this.redis.get(PENDING_TX_KEY),
      network: this.network,
      buybackAddress: this.buybackAddress,
      treasuryAddress: this.treasuryAddress,
      opsAddress: this.opsAddress,
      burn: this.burnPolicy ? 'on-chain burn (negative mint)' : `sent to burn wallet ${this.burnAddress}`,
      l4vaUnit: this.l4vaUnit,
      balances: { lovelace: balances.lovelace.toString(), l4va: balances.l4va.toString() },
      config: {
        burnBps: this.split.burnBps.toString(),
        treasuryBps: this.split.treasuryBps.toString(),
        reserveLovelace: this.reserveLovelace.toString(),
        minSwapLovelace: this.minSwapLovelace.toString(),
        maxSwapLovelace: this.maxSwapLovelace.toString(),
        slippagePct: this.slippagePct,
        maxPriceImpactBps: this.maxPriceImpactBps.toString(),
        minL4vaPerAda: this.minL4vaPerAda.toString(),
        minDistribute: this.minDistribute.toString(),
      },
      nextAction: distribution
        ? { action: 'distribute', split: stringifySplit(distribution) }
        : swapLovelace
          ? { action: 'swap', lovelaceIn: swapLovelace.toString() }
          : { action: 'idle' },
    };
  }

  @Cron(process.env.CARDANO_BUYBACK_CRON || CronExpression.EVERY_6_HOURS)
  async scheduledCycle(): Promise<void> {
    const missing = this.missingConfig();
    if (missing.length > 0) {
      if (!this.notConfiguredWarned) {
        this.logger.warn(`Cardano buyback skipped, not configured: missing ${missing.join(', ')}`);
        this.notConfiguredWarned = true;
      }
      return;
    }

    try {
      const result = await this.runCycle();
      this.logger.log(`Cardano buyback cycle: ${JSON.stringify(result)}`);
    } catch (error: any) {
      this.logger.error(`Cardano buyback cycle failed: ${error.message}`, error.stack);
    }
  }

  /** One buyback cycle: distribute pending L4VA, else swap spendable ADA. */
  async runCycle(): Promise<BuybackCycleResult> {
    this.assertConfigured();
    if (!this.systemSettingsService.cardanoBuybackEnabled) {
      return { action: 'skipped', reason: 'Cardano buyback is disabled in system settings' };
    }

    const acquired = (await this.redis.set(LOCK_KEY, '1', 'EX', LOCK_TTL_SECONDS, 'NX')) === 'OK';
    if (!acquired) return { action: 'skipped', reason: 'Another buyback cycle is running' };

    try {
      const pending = await this.redis.get(PENDING_TX_KEY);
      if (pending) {
        if (!(await this.isConfirmed(pending))) {
          return { action: 'skipped', reason: `Waiting for previous buyback tx ${pending} to confirm` };
        }
        await this.redis.del(PENDING_TX_KEY);
      }

      const balances = await this.getBalances(this.buybackAddress);

      const distribution = planDistribution(balances.l4va, this.minDistribute, this.split);
      if (distribution) {
        const txHash = await this.distribute(distribution);
        return { action: 'distributed', txHash, split: stringifySplit(distribution) };
      }

      const lovelaceIn = planSwapAmount({
        lovelaceBalance: balances.lovelace,
        reserveLovelace: this.reserveLovelace,
        minSwapLovelace: this.minSwapLovelace,
        maxSwapLovelace: this.maxSwapLovelace,
      });
      if (!lovelaceIn) {
        return {
          action: 'idle',
          reason: `Spendable ADA below minimum (balance ${balances.lovelace}, reserve ${this.reserveLovelace}, min ${this.minSwapLovelace} lovelace)`,
        };
      }

      return await this.swap(lovelaceIn);
    } finally {
      await this.redis.del(LOCK_KEY).catch(() => undefined);
    }
  }

  private async isConfirmed(txHash: string): Promise<boolean> {
    try {
      await this.blockfrost.txs(txHash);
      return true;
    } catch (error: any) {
      if (error?.status_code === 404) return false;
      throw error;
    }
  }

  /**
   * Checks a DexHunter quote (estimate or build response). Missing output or
   * price-impact data is a rejection, never a zero. `price_impact` is read as a
   * percentage (DexHunter's unit; 3 = 3%).
   */
  private evaluateQuote(
    lovelaceIn: bigint,
    totalOutput: unknown,
    splits: unknown
  ): { ok: true; minOut: bigint; priceImpactsPct: number[] } | { ok: false; reason: string } {
    if (totalOutput === undefined || totalOutput === null || !Number.isFinite(Number(totalOutput))) {
      return { ok: false, reason: 'Quote has no total_output' };
    }
    if (!Array.isArray(splits) || splits.length === 0) {
      return { ok: false, reason: 'Quote has no route splits, price impact unknown' };
    }
    const priceImpactsPct = splits.map((s: any) => Number(s?.priceImpact ?? s?.price_impact));
    if (priceImpactsPct.some(p => !Number.isFinite(p))) {
      return { ok: false, reason: 'Quote split without price impact' };
    }

    const minOut = displayToBase(String(totalOutput), this.l4vaDecimals);
    const check = checkQuote({
      lovelaceIn,
      minOut,
      priceImpactsPct,
      maxPriceImpactBps: this.maxPriceImpactBps,
      minL4vaPerAda: this.minL4vaPerAda,
    });
    return check.ok === false ? check : { ok: true, minOut, priceImpactsPct };
  }

  private async swap(lovelaceIn: bigint): Promise<BuybackCycleResult> {
    const adaIn = baseToDisplay(lovelaceIn, 6);

    const estimate = await this.dexHunterService.estimateSwap({
      tokenIn: 'ADA',
      tokenOut: this.l4vaUnit,
      amountIn: adaIn,
      slippage: this.slippagePct,
    });

    const quote = this.evaluateQuote(lovelaceIn, estimate.totalOutput, estimate.splits);
    if (quote.ok === false) {
      return { action: 'idle', reason: `Quote rejected: ${quote.reason}` };
    }
    const { priceImpactsPct } = quote;
    let { minOut } = quote;

    const transaction = await this.transactionsService.createTransaction({
      vault_id: null,
      type: TransactionType.swap,
      assets: [],
      amount: lovelaceIn.toString(),
      metadata: {
        buyback: 'cardano',
        tokenIn: 'ADA',
        tokenOut: this.l4vaUnit,
        lovelaceIn: lovelaceIn.toString(),
        minL4vaOut: minOut.toString(),
        slippagePct: this.slippagePct,
        priceImpactsPct,
      },
    });

    try {
      const { txHash } = await this.dexHunterService.buildSignAndSubmitSwap({
        address: this.buybackAddress,
        tokenIn: 'ADA',
        tokenOut: this.l4vaUnit,
        amountIn: adaIn,
        slippage: this.slippagePct,
        signingKeys: [PrivateKey.from_bech32(this.buybackSKey)],
        // The built tx can carry a different route and price than the estimate,
        // so the quote that is actually signed is the one checked.
        beforeSign: buildData => {
          const built = this.evaluateQuote(lovelaceIn, buildData?.total_output, buildData?.splits);
          if (built.ok === false) throw new Error(`Built swap rejected: ${built.reason}`);
          minOut = built.minOut;
        },
      });

      await this.redis.set(PENDING_TX_KEY, txHash, 'EX', PENDING_TX_TTL_SECONDS);
      await this.transactionsService.updateTransactionHash(transaction.id, txHash);
      this.logger.log(`Buyback swap ${adaIn} ADA → ≥${minOut} L4VA base units submitted: ${txHash}`);

      return { action: 'swapped', txHash, lovelaceIn: lovelaceIn.toString(), minL4vaOut: minOut.toString() };
    } catch (error) {
      await this.transactionsService.updateTransactionStatusById(transaction.id, TransactionStatus.failed);
      throw error;
    }
  }

  private async distribute(split: BuybackSplit): Promise<string> {
    const transaction = await this.transactionsService.createTransaction({
      vault_id: null,
      type: TransactionType.burn,
      assets: [],
      metadata: {
        buyback: 'cardano',
        l4vaUnit: this.l4vaUnit,
        burnMode: this.burnPolicy ? 'mint' : 'burn-wallet',
        ...stringifySplit(split),
      },
    });

    try {
      const network = lucidNetworkFromCardanoEnv(this.isMainnet);
      const lucid = await Lucid(createLucidBlockfrostProvider(this.blockfrostProjectId, network), network);
      lucid.selectWallet.fromAddress(this.buybackAddress, await lucid.utxosAt(this.buybackAddress));

      let tx = lucid.newTx();
      if (split.burn > 0n) {
        tx = this.burnPolicy
          ? tx.mintAssets({ [this.l4vaUnit]: -split.burn }, L4VA_BURN_REDEEMER).attach.MintingPolicy(this.burnPolicy)
          : tx.pay.ToAddress(this.burnAddress, { [this.l4vaUnit]: split.burn });
      }
      if (split.treasury > 0n) tx = tx.pay.ToAddress(this.treasuryAddress, { [this.l4vaUnit]: split.treasury });
      if (split.ops > 0n) tx = tx.pay.ToAddress(this.opsAddress, { [this.l4vaUnit]: split.ops });

      const signed = await (await tx.complete()).sign.withPrivateKey(this.buybackSKey).complete();
      const txHash = await signed.submit();
      await this.redis.set(PENDING_TX_KEY, txHash, 'EX', PENDING_TX_TTL_SECONDS);
      await this.transactionsService.updateTransactionHash(transaction.id, txHash);

      this.logger.log(
        `Buyback distribution submitted ${txHash}: burn ${split.burn}, treasury ${split.treasury}, ops ${split.ops}`
      );
      return txHash;
    } catch (error) {
      await this.transactionsService.updateTransactionStatusById(transaction.id, TransactionStatus.failed);
      throw error;
    }
  }

  /** Move protocol-fee ADA from the admin wallet into the buyback wallet. */
  async fund(lovelace: bigint): Promise<{ txHash: string }> {
    this.assertConfigured();
    if (!this.adminAddress || !this.adminSKey || !this.adminHash) {
      throw new BadRequestException('Admin wallet not configured (ADMIN_ADDRESS, ADMIN_S_KEY, ADMIN_KEY_HASH)');
    }
    if (lovelace < 1_000_000n) {
      throw new BadRequestException('Funding amount must be at least 1 ADA');
    }

    const acquired = (await this.redis.set(FUND_LOCK_KEY, '1', 'EX', LOCK_TTL_SECONDS, 'NX')) === 'OK';
    if (!acquired) throw new BadRequestException('Another buyback funding is in progress');

    try {
      return await this.fundLocked(lovelace);
    } finally {
      await this.redis.del(FUND_LOCK_KEY).catch(() => undefined);
    }
  }

  private async fundLocked(lovelace: bigint): Promise<{ txHash: string }> {
    const { utxos } = await getUtxosExtract(Address.from_bech32(this.adminAddress), this.blockfrost, {
      targetAdaAmount: Number(lovelace + FUND_FEE_HEADROOM_LOVELACE),
    });

    const transaction = await this.transactionsService.createTransaction({
      vault_id: null,
      type: TransactionType.payment,
      assets: [],
      amount: lovelace.toString(),
      metadata: { buyback: 'cardano', purpose: 'fund', to: this.buybackAddress },
    });

    try {
      const buildResponse = await this.blockchainService.buildTransaction({
        changeAddress: this.adminAddress,
        message: 'L4VA buyback funding',
        utxos,
        outputs: [{ address: this.buybackAddress, lovelace: Number(lovelace) }],
        requiredSigners: [this.adminHash],
        network: this.network,
      });

      const tx = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
      tx.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

      const { txHash } = await this.blockchainService.submitTransaction({ transaction: tx.to_hex(), signatures: [] });
      await this.transactionsService.updateTransactionHash(transaction.id, txHash);

      this.logger.log(`Buyback wallet funded with ${lovelace} lovelace: ${txHash}`);
      return { txHash };
    } catch (error) {
      await this.transactionsService.updateTransactionStatusById(transaction.id, TransactionStatus.failed);
      throw error;
    }
  }
}

function stringifySplit(split: BuybackSplit): Record<keyof BuybackSplit, string> {
  return { burn: split.burn.toString(), treasury: split.treasury.toString(), ops: split.ops.toString() };
}
