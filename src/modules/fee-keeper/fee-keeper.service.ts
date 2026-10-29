import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createWalletClient, http, type Account, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { EvmContractReader } from '../vaults/processing-tx/onchain/evm-contract-reader.service';
import { VAULT_ABI } from '../vaults/processing-tx/onchain/vault.abi';

import { ERC20_BALANCE_ABI, FEE_CONTROLLER_ABI, FEE_CONVERTER_ABI, L4VA_BURN_ABI } from './fee-keeper.abis';
import { loadFeeKeeperConfig, type FeeKeeperConfig } from './fee-keeper.config';
import {
  applySlippage,
  chunk,
  isTransientError,
  maxBigint,
  minBigint,
  randomConvertAmount,
  randomInt,
  withRetries,
} from './fee-keeper.math';
import { assertRouteMatches, ZERO_ADDRESS } from './fee-keeper.routes';

import { Vault } from '@/database/vault.entity';
import { AlertsService } from '@/modules/alerts/alerts.service';
import { ChainType } from '@/types/vault.types';

const DEADLINE_SECONDS = 300n;

type Stage = 'preflight' | 'collect' | 'convert' | 'deposit' | 'distribute';

export interface FeeKeeperRunReport {
  startedAt: string;
  finishedAt?: string;
  keeper?: Address;
  collected: Array<{ asset: Address; vaults: number; txHash: Hex }>;
  converted: Array<{ asset: Address; amountIn: string; expectedOut: string; minOut: string; txHash: Hex }>;
  deposited?: { amount: string; txHash: Hex };
  distributed: Array<{ bucket: 'burn' | 'treasury' | 'operations'; amount: string; txHash: Hex }>;
  skipped: string[];
  errors: Array<{ stage: Stage; message: string }>;
}

/** A transaction was broadcast but its outcome is unknown; never resend blindly. */
export class KeeperTxPendingError extends Error {
  constructor(
    readonly label: string,
    readonly hash: Hex,
    cause: unknown
  ) {
    super(`${label}: tx ${hash} broadcast but not confirmed (${(cause as Error)?.message ?? cause})`);
    this.name = 'KeeperTxPendingError';
  }
}

export class KeeperTxRevertedError extends Error {
  constructor(
    readonly label: string,
    readonly hash: Hex
  ) {
    super(`${label}: tx ${hash} reverted`);
    this.name = 'KeeperTxRevertedError';
  }
}

/**
 * Protocol fee keeper: turns in-vault protocol fees into L4VA buybacks.
 *
 *   collect     — FeeConverter.collect(vaults, asset) for every asset with accrued fees
 *   convert     — the buy: per configured route, FeeConverter.convert swaps fees into
 *                 L4VA (the fee token). Buys happen at random gaps and in random sizes
 *                 (bounded by the on-chain cap) so demand is smooth and cannot be timed.
 *   deposit     — FeeConverter.depositFeeToken() for L4VA fees that need no swap
 *   distribute  — (FEE_KEEPER_DISTRIBUTE_ENABLED) pay out FeeController's buckets:
 *                 25% burned by the keeper, 25% treasury, 50% operations
 *
 * FeeController splits every deposit 25/25/50 on-chain; this keeper only moves
 * what the contract already allocated.
 *
 * Safety model: every stage re-reads on-chain balances, so a crashed or
 * repeated run cannot double-spend — the contracts reject amounts above what
 * they hold. Only pre-broadcast transient errors are retried; a broadcast tx
 * whose receipt times out stops the run and alerts instead of resending.
 */
@Injectable()
export class FeeKeeperService implements OnModuleInit {
  private readonly logger = new Logger(FeeKeeperService.name);
  private config: FeeKeeperConfig | null = null;
  private account: Account | null = null;
  private walletClient: any = null;
  private running = false;
  private lastRun: FeeKeeperRunReport | null = null;
  /**
   * Earliest time of the next buy (convert). Buys land at random gaps and in
   * random sizes so the L4VA demand is smooth and cannot be timed (e.g. around
   * vault launches). In-memory: after a restart the first eligible tick may buy.
   */
  private nextBuyAt = 0;

  constructor(
    @InjectRepository(Vault) private readonly vaultsRepository: Repository<Vault>,
    private readonly contractReader: EvmContractReader,
    private readonly alerts: AlertsService
  ) {}

  onModuleInit(): void {
    try {
      this.config = loadFeeKeeperConfig(process.env);
    } catch (err) {
      this.config = null;
      this.logger.error(`Fee keeper disabled: invalid configuration — ${(err as Error).message}`);
      void this.alerts.sendAlert('fee_keeper_misconfigured', { error: (err as Error).message });
      return;
    }
    if (!this.config.enabled) {
      this.logger.log('Fee keeper disabled (FEE_KEEPER_ENABLED not set)');
      return;
    }
    this.account = privateKeyToAccount(this.config.privateKey);
    this.walletClient = createWalletClient({ account: this.account, transport: http(this.config.rpcUrl) });
    this.logger.log(
      `Fee keeper enabled: keeper=${this.account.address} converter=${this.config.feeConverter} ` +
        `routes=${this.config.routes.length} distribute=${this.config.distribute.enabled}`
    );
  }

  getLastRun(): FeeKeeperRunReport | null {
    return this.lastRun;
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async scheduledRun(): Promise<void> {
    if (!this.config?.enabled) return;
    await this.runOnce();
  }

  async runOnce(): Promise<FeeKeeperRunReport | null> {
    const cfg = this.config;
    if (!cfg?.enabled || !this.account) return null;
    if (this.running) {
      this.logger.warn('Fee keeper run already in progress; skipping');
      return this.lastRun;
    }
    this.running = true;

    const report: FeeKeeperRunReport = {
      startedAt: new Date().toISOString(),
      keeper: this.account.address,
      collected: [],
      converted: [],
      distributed: [],
      skipped: [],
      errors: [],
    };

    try {
      const ctx = await this.stage('preflight', report, () => this.preflight(cfg, report));
      if (!ctx) return report;

      await this.stage('collect', report, () => this.collectStage(cfg, ctx.feeToken, report));
      if (ctx.canConvert) {
        if (Date.now() < this.nextBuyAt) {
          report.skipped.push(`convert: next buy not before ${new Date(this.nextBuyAt).toISOString()}`);
        } else {
          await this.stage('convert', report, () => this.convertStage(cfg, report));
          if (report.converted.length > 0) {
            const gapMinutes = randomInt(cfg.buy.minIntervalMinutes, cfg.buy.maxIntervalMinutes);
            this.nextBuyAt = Date.now() + gapMinutes * 60_000;
          }
        }
        await this.stage('deposit', report, () => this.depositStage(cfg, ctx.feeToken, report));
      }
      if (ctx.canDistribute) {
        await this.stage('distribute', report, () => this.distributeStage(cfg, ctx.feeToken, report));
      }
      return report;
    } finally {
      report.finishedAt = new Date().toISOString();
      this.lastRun = report;
      this.running = false;
      this.logger.log(
        `Fee keeper run: collected=${report.collected.length} converted=${report.converted.length} ` +
          `deposited=${report.deposited ? report.deposited.amount : '0'} ` +
          `distributed=${report.distributed.length} ` +
          `skipped=${report.skipped.length} errors=${report.errors.length}`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Stages
  // ---------------------------------------------------------------------------

  private async preflight(
    cfg: FeeKeeperConfig,
    report: FeeKeeperRunReport
  ): Promise<{ feeToken: Address; canConvert: boolean; canDistribute: boolean }> {
    const client = this.contractReader.publicClient;
    const keeper = this.account!.address;

    const [converterFeeToken, controllerFeeToken, keeperRole, paused, gas] = await Promise.all([
      client.readContract({ address: cfg.feeConverter, abi: FEE_CONVERTER_ABI, functionName: 'feeToken' }),
      client.readContract({ address: cfg.feeController, abi: FEE_CONTROLLER_ABI, functionName: 'feeToken' }),
      client.readContract({ address: cfg.feeConverter, abi: FEE_CONVERTER_ABI, functionName: 'KEEPER_ROLE' }),
      client.readContract({ address: cfg.feeConverter, abi: FEE_CONVERTER_ABI, functionName: 'paused' }),
      client.getBalance({ address: keeper }),
    ]);

    const feeToken = converterFeeToken as Address;
    if (feeToken.toLowerCase() !== (controllerFeeToken as Address).toLowerCase()) {
      throw new Error(`FeeConverter.feeToken ${feeToken} != FeeController.feeToken ${controllerFeeToken}`);
    }
    for (const r of cfg.routes) assertRouteMatches(r.route, r.asset, feeToken, cfg.weth);

    if (cfg.minGasWei > 0n && (gas as bigint) < cfg.minGasWei) {
      await this.alerts.sendAlert('fee_keeper_low_gas', { keeper, balanceWei: (gas as bigint).toString() });
    }

    const hasKeeperRole = (await client.readContract({
      address: cfg.feeConverter,
      abi: FEE_CONVERTER_ABI,
      functionName: 'hasRole',
      args: [keeperRole, keeper],
    })) as boolean;

    let canConvert = true;
    if (paused) {
      canConvert = false;
      report.skipped.push('convert/deposit: FeeConverter is paused');
    } else if (!hasKeeperRole) {
      canConvert = false;
      report.skipped.push('convert: keeper lacks KEEPER_ROLE on FeeConverter');
      await this.alerts.sendAlert('fee_keeper_misconfigured', { keeper, missing: 'FeeConverter.KEEPER_ROLE' });
    }

    let canDistribute = false;
    if (cfg.distribute.enabled) {
      const [role, cPaused] = await Promise.all([
        client.readContract({ address: cfg.feeController, abi: FEE_CONTROLLER_ABI, functionName: 'EXECUTOR_ROLE' }),
        client.readContract({ address: cfg.feeController, abi: FEE_CONTROLLER_ABI, functionName: 'paused' }),
      ]);
      const hasExec = (await client.readContract({
        address: cfg.feeController,
        abi: FEE_CONTROLLER_ABI,
        functionName: 'hasRole',
        args: [role, keeper],
      })) as boolean;
      canDistribute = hasExec && !cPaused;
      if (!hasExec) {
        report.skipped.push('distribute: keeper lacks EXECUTOR_ROLE on FeeController');
        await this.alerts.sendAlert('fee_keeper_misconfigured', { keeper, missing: 'FeeController.EXECUTOR_ROLE' });
      } else if (cPaused) {
        report.skipped.push('distribute: FeeController is paused');
      }
    }

    return { feeToken, canConvert, canDistribute };
  }

  private async collectStage(cfg: FeeKeeperConfig, feeToken: Address, report: FeeKeeperRunReport): Promise<void> {
    const client = this.contractReader.publicClient;
    const vaults = await this.vaultsRepository.find({
      where: { chain_type: ChainType.robinhood },
      select: ['id', 'contract_address'],
    });
    const addresses = vaults.map(v => v.contract_address).filter((a): a is string => !!a) as Address[];
    if (addresses.length === 0) return;

    const assets = this.uniqueAddresses([ZERO_ADDRESS, feeToken, ...cfg.routes.map(r => r.asset)]);

    for (const asset of assets) {
      const withFees: Address[] = [];
      for (const group of chunk(addresses, 25)) {
        const accrued = await Promise.all(
          group.map(vault =>
            (asset === ZERO_ADDRESS
              ? client.readContract({ address: vault, abi: VAULT_ABI, functionName: 'accruedFeeNative' })
              : client.readContract({ address: vault, abi: VAULT_ABI, functionName: 'accruedFeeErc20', args: [asset] })
            ).catch(() => 0n)
          )
        );
        group.forEach((vault, i) => {
          if ((accrued[i] as bigint) > 0n) withFees.push(vault);
        });
      }

      for (const batch of chunk(withFees, cfg.vaultBatchSize)) {
        const { hash } = await this.send(cfg, `collect(${asset})`, {
          address: cfg.feeConverter,
          abi: FEE_CONVERTER_ABI,
          functionName: 'collect',
          args: [batch, asset],
        });
        report.collected.push({ asset, vaults: batch.length, txHash: hash });
      }
    }
  }

  private async convertStage(cfg: FeeKeeperConfig, report: FeeKeeperRunReport): Promise<void> {
    const client = this.contractReader.publicClient;

    for (const entry of cfg.routes) {
      const label = `convert(${entry.asset})`;
      try {
        const [balance, cap] = await Promise.all([
          this.balanceOf(entry.asset, cfg.feeConverter),
          client.readContract({
            address: cfg.feeConverter,
            abi: FEE_CONVERTER_ABI,
            functionName: 'maxConversionAmount',
            args: [entry.asset],
          }) as Promise<bigint>,
        ]);
        if (balance === 0n) continue;
        if (cap === 0n) {
          report.skipped.push(`${label}: no conversion cap set on-chain`);
          continue;
        }
        const amountIn = randomConvertAmount(minBigint(balance, cap), cfg.buy.minChunkBps);
        const deadline = await this.deadline();

        // Quote by simulating the exact on-chain path with the loosest floor.
        const { result: expectedOut } = await withRetries<{ result: bigint }>(
          () =>
            client.simulateContract({
              account: this.account,
              address: cfg.feeConverter,
              abi: FEE_CONVERTER_ABI,
              functionName: 'convert',
              args: [entry.asset, amountIn, cfg.swapAdapter, 1n, deadline, entry.encoded],
            }),
          { retries: cfg.maxRetries, baseDelayMs: 500, isRetryable: isTransientError }
        );
        if ((expectedOut as bigint) < cfg.minConvertOut || (expectedOut as bigint) === 0n) {
          report.skipped.push(`${label}: simulated output ${expectedOut} below FEE_KEEPER_MIN_CONVERT_OUT`);
          continue;
        }

        const minOut = maxBigint(applySlippage(expectedOut as bigint, cfg.slippageBps), 1n);
        const { hash } = await this.send(cfg, label, {
          address: cfg.feeConverter,
          abi: FEE_CONVERTER_ABI,
          functionName: 'convert',
          args: [entry.asset, amountIn, cfg.swapAdapter, minOut, deadline, entry.encoded],
        });
        report.converted.push({
          asset: entry.asset,
          amountIn: amountIn.toString(),
          expectedOut: (expectedOut as bigint).toString(),
          minOut: minOut.toString(),
          txHash: hash,
        });
      } catch (err) {
        // One bad route must not block the others; pending txs still abort the run.
        if (err instanceof KeeperTxPendingError) throw err;
        report.errors.push({ stage: 'convert', message: `${label}: ${(err as Error).message}` });
        await this.alerts.sendAlert('fee_keeper_convert_failed', { asset: entry.asset, error: (err as Error).message });
      }
    }
  }

  private async depositStage(cfg: FeeKeeperConfig, feeToken: Address, report: FeeKeeperRunReport): Promise<void> {
    const balance = await this.balanceOf(feeToken, cfg.feeConverter);
    if (balance === 0n) return;
    const { hash } = await this.send(cfg, 'depositFeeToken', {
      address: cfg.feeConverter,
      abi: FEE_CONVERTER_ABI,
      functionName: 'depositFeeToken',
      args: [],
    });
    report.deposited = { amount: balance.toString(), txHash: hash };
  }

  /**
   * Pay out FeeController's L4VA buckets. The burn bucket is withdrawn to the
   * keeper and burned; any L4VA the keeper still holds (a burn that failed after
   * its withdraw) is burned first, so a crash mid-way never strands it.
   */
  private async distributeStage(cfg: FeeKeeperConfig, l4va: Address, report: FeeKeeperRunReport): Promise<void> {
    const client = this.contractReader.publicClient;
    const keeper = this.account!.address;

    await this.burnKeeperBalance(cfg, l4va, report);

    const [burnReserve, treasuryReserve, operationsReserve] = (await Promise.all([
      client.readContract({ address: cfg.feeController, abi: FEE_CONTROLLER_ABI, functionName: 'burnReserve' }),
      client.readContract({ address: cfg.feeController, abi: FEE_CONTROLLER_ABI, functionName: 'treasuryReserve' }),
      client.readContract({ address: cfg.feeController, abi: FEE_CONTROLLER_ABI, functionName: 'operationsReserve' }),
    ])) as [bigint, bigint, bigint];

    if (burnReserve > 0n) {
      await this.send(cfg, 'withdrawBurn', {
        address: cfg.feeController,
        abi: FEE_CONTROLLER_ABI,
        functionName: 'withdrawBurn',
        args: [burnReserve, keeper],
      });
      await this.burnKeeperBalance(cfg, l4va, report);
    }

    const payouts: Array<['treasury' | 'operations', 'withdrawTreasury' | 'withdrawOperations', bigint, Address]> = [
      ['treasury', 'withdrawTreasury', treasuryReserve, cfg.distribute.treasury!],
      ['operations', 'withdrawOperations', operationsReserve, cfg.distribute.operations!],
    ];
    for (const [bucket, functionName, amount, to] of payouts) {
      if (amount === 0n) continue;
      const { hash } = await this.send(cfg, functionName, {
        address: cfg.feeController,
        abi: FEE_CONTROLLER_ABI,
        functionName,
        args: [amount, to],
      });
      report.distributed.push({ bucket, amount: amount.toString(), txHash: hash });
    }
  }

  private async burnKeeperBalance(cfg: FeeKeeperConfig, l4va: Address, report: FeeKeeperRunReport): Promise<void> {
    const balance = await this.balanceOf(l4va, this.account!.address);
    if (balance === 0n) return;
    const { hash } = await this.send(cfg, 'burn', {
      address: l4va,
      abi: L4VA_BURN_ABI,
      functionName: 'burn',
      args: [balance],
    });
    report.distributed.push({ bucket: 'burn', amount: balance.toString(), txHash: hash });
  }

  // ---------------------------------------------------------------------------
  // Transaction plumbing
  // ---------------------------------------------------------------------------

  /**
   * simulate → write → receipt. Simulation and broadcast are retried on
   * transient errors; once a hash exists, a receipt timeout is surfaced as
   * `KeeperTxPendingError` and never resent.
   */
  private async send(
    cfg: FeeKeeperConfig,
    label: string,
    call: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }
  ): Promise<{ hash: Hex }> {
    const client = this.contractReader.publicClient;

    const hash = (await withRetries(
      async () => {
        const { request } = await client.simulateContract({ ...call, account: this.account });
        return this.walletClient.writeContract(request);
      },
      { retries: cfg.maxRetries, baseDelayMs: 1_000, isRetryable: isTransientError }
    )) as Hex;

    let receipt: any;
    try {
      receipt = await client.waitForTransactionReceipt({ hash, timeout: cfg.txTimeoutMs });
    } catch (err) {
      await this.alerts.sendAlert('fee_keeper_tx_pending', { label, hash, error: (err as Error).message });
      throw new KeeperTxPendingError(label, hash, err);
    }
    if (receipt.status !== 'success') throw new KeeperTxRevertedError(label, hash);

    this.logger.log(`${label} confirmed tx=${hash}`);
    return { hash };
  }

  private async stage<T>(name: Stage, report: FeeKeeperRunReport, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      const message = (err as Error).message;
      report.errors.push({ stage: name, message });
      this.logger.error(`Fee keeper stage ${name} failed: ${message}`);
      await this.alerts.sendAlert(`fee_keeper_${name}_failed`, { error: message });
      if (err instanceof KeeperTxPendingError) throw err;
      return null;
    }
  }

  private async balanceOf(asset: Address, holder: Address): Promise<bigint> {
    const client = this.contractReader.publicClient;
    if (asset.toLowerCase() === ZERO_ADDRESS) return (await client.getBalance({ address: holder })) as bigint;
    return (await client.readContract({
      address: asset,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [holder],
    })) as bigint;
  }

  private async deadline(): Promise<bigint> {
    const block = await this.contractReader.publicClient.getBlock();
    return (block.timestamp as bigint) + DEADLINE_SECONDS;
  }

  private uniqueAddresses(addresses: Address[]): Address[] {
    const seen = new Set<string>();
    return addresses.filter(a => {
      const k = a.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
}
