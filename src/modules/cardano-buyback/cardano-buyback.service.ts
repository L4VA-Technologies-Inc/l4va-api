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
import { REDIS_CLIENT } from '@/modules/redis/redis.module';
import { TransactionsService } from '@/modules/vaults/processing-tx/offchain-tx/transactions.service';
import { BlockchainService } from '@/modules/vaults/processing-tx/onchain/blockchain.service';
import { getUtxosExtract } from '@/modules/vaults/processing-tx/onchain/utils/lib';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

const LOCK_KEY = 'cardano-buyback:cycle:lock';
const LOCK_TTL_SECONDS = 600;

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
 * holder burn (src/scripts/cardano/deployments). For a policy that is not one
 * of our deployments (older test tokens) the burn share goes to the protocol
 * burn wallet instead.
 */
@Injectable()
export class CardanoBuybackService {
  private readonly logger = new Logger(CardanoBuybackService.name);

  private notConfiguredWarned = false;
  private readonly isMainnet: boolean;
  private readonly blockfrost: BlockFrostAPI;
  private readonly blockfrostProjectId: string;

  private readonly l4vaPolicyId: string;
  private readonly l4vaAssetName: string;
  private readonly l4vaDecimals: number;

  private readonly buybackAddress: string;
  private readonly buybackSKey: string;
  private readonly treasuryAddress: string;
  private readonly opsAddress: string;
  private readonly burnAddress: string;
  private readonly burnPolicy: MintingPolicy | null;

  private readonly adminAddress: string;
  private readonly adminSKey: string;
  private readonly adminHash: string;

  private readonly split: BuybackSplitBps;
  private readonly reserveLovelace: bigint;
  private readonly minSwapLovelace: bigint;
  private readonly maxSwapLovelace: bigint;
  private readonly slippagePct: number;
  private readonly maxPriceImpactBps: bigint;
  private readonly minL4vaPerAda: bigint;
  private readonly minDistribute: bigint;

  constructor(
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService,
    private readonly dexHunterService: DexHunterService,
    private readonly transactionsService: TransactionsService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis
  ) {
    const get = (key: string): string | undefined =>
      this.configService.get<string>(key)?.toString().trim() || undefined;
    const big = (key: string, fallback: bigint): bigint => (get(key) ? BigInt(get(key)) : fallback);

    this.isMainnet = get('CARDANO_NETWORK') === 'mainnet';
    this.blockfrostProjectId = get('BLOCKFROST_API_KEY');
    this.blockfrost = new BlockFrostAPI({ projectId: this.blockfrostProjectId });

    this.l4vaPolicyId = get('L4VA_POLICY_ID')?.toLowerCase() ?? '';
    this.l4vaAssetName = get('L4VA_ASSET_NAME')?.toLowerCase() ?? '';
    this.l4vaDecimals = Number(get('L4VA_DECIMALS') ?? 6);

    this.buybackAddress = get('CARDANO_BUYBACK_ADDRESS');
    this.buybackSKey = get('CARDANO_BUYBACK_S_KEY');
    this.treasuryAddress = get('CARDANO_BUYBACK_TREASURY_ADDRESS') ?? get('L4VA_TREASURY_ADDRESS');
    this.opsAddress = get('CARDANO_BUYBACK_OPS_ADDRESS');
    this.burnAddress = get('CARDANO_BUYBACK_BURN_ADDRESS') ?? getBurnWallet(this.isMainnet);
    this.burnPolicy = this.l4vaPolicyId ? findL4vaPolicy(this.l4vaPolicyId) : null;

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
    this.minDistribute = big('CARDANO_BUYBACK_MIN_DISTRIBUTE', 10n ** BigInt(this.l4vaDecimals));
  }

  private get l4vaUnit(): string {
    return `${this.l4vaPolicyId}${this.l4vaAssetName}`;
  }

  private get network(): 'mainnet' | 'preprod' {
    return this.isMainnet ? 'mainnet' : 'preprod';
  }

  private missingConfig(): string[] {
    return Object.entries({
      L4VA_POLICY_ID: this.l4vaPolicyId,
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
    this.assertConfigured();
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

    const acquired = (await this.redis.set(LOCK_KEY, '1', 'EX', LOCK_TTL_SECONDS, 'NX')) === 'OK';
    if (!acquired) return { action: 'skipped', reason: 'Another buyback cycle is running' };

    try {
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

  private async swap(lovelaceIn: bigint): Promise<BuybackCycleResult> {
    const adaIn = baseToDisplay(lovelaceIn, 6);

    const estimate = await this.dexHunterService.estimateSwap({
      tokenIn: 'ADA',
      tokenOut: this.l4vaUnit,
      amountIn: adaIn,
      slippage: this.slippagePct,
    });

    const minOut = displayToBase(estimate.totalOutput, this.l4vaDecimals);
    // estimateSwap passes DexHunter's raw split objects through.
    const priceImpactsPct = (estimate.splits ?? []).map((s: any) => Number(s.priceImpact ?? s.price_impact ?? 0));

    const check = checkQuote({
      lovelaceIn,
      minOut,
      priceImpactsPct,
      maxPriceImpactBps: this.maxPriceImpactBps,
      minL4vaPerAda: this.minL4vaPerAda,
    });
    if (check.ok === false) {
      return { action: 'idle', reason: `Quote rejected: ${check.reason}` };
    }

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
      });

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

    const { utxos } = await getUtxosExtract(Address.from_bech32(this.adminAddress), this.blockfrost, {
      targetAdaAmount: Number(lovelace),
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
