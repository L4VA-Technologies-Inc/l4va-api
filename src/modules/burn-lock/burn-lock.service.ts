import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  getAddress,
  http,
  type Account,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { BURN_LOCK_ABI } from './burn-lock.abi';

/** Keep the keeper topped up above this; below it every run logs a warning. */
const LOW_BALANCE_WEI = 200_000_000_000_000n; // 0.0002 ETH ≈ 200+ burns at current gas

export type BurnRunResult =
  | { status: 'disabled' }
  | { status: 'busy' }
  | { status: 'not-started'; nextBurnAt: number }
  | { status: 'nothing-due'; nextBurnAt: number }
  | { status: 'burned'; hash: Hex; amount: string }
  | { status: 'failed'; error: string };

/**
 * Daily keeper for L4VABurnLock on Robinhood Chain.
 *
 * Contracts can't schedule themselves, so this calls the permissionless
 * `burn()` once the next day's allowance unlocks. It checks every 2 hours
 * rather than at a fixed time of day: the contract's day boundary is
 * `startTime`, not midnight, and the check is a free read. Whether today's
 * burn already happened is tracked on-chain — `burnable()` is 0 until the
 * next day unlocks — so a burn tx goes out at most once per day.
 *
 * Safe to run on several instances: the loser of a race fails simulation
 * with `NothingToBurn` and skips without paying gas. Downtime is harmless
 * too — missed days carry over on-chain and the next call burns them.
 *
 * The keeper key should be a dedicated low-balance wallet: it can do nothing
 * on the contract except trigger the burn.
 *
 * Env:
 *   BURN_LOCK_ENABLED=true
 *   BURN_LOCK_ADDRESS=0x...
 *   BURN_LOCK_KEEPER_PRIVATE_KEY=0x...
 *   EVM_RPC_URL, EVM_CHAIN_ID (shared)
 */
@Injectable()
export class BurnLockService implements OnModuleInit {
  private readonly logger = new Logger(BurnLockService.name);

  private readonly enabled: boolean;
  private readonly address: Address | null = null;
  private readonly account: Account | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly publicClient: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly walletClient: any;

  private running = false;

  constructor(private readonly configService: ConfigService) {
    const flag = this.configService.get<string>('BURN_LOCK_ENABLED');
    const rawAddress = this.configService.get<string>('BURN_LOCK_ADDRESS')?.trim();
    const privateKey = this.configService.get<string>('BURN_LOCK_KEEPER_PRIVATE_KEY')?.trim();
    const rpcUrl = this.configService.get<string>('EVM_RPC_URL');
    const chainId = Number(this.configService.get<string>('EVM_CHAIN_ID') || '46630');

    const wanted = flag === 'true' || flag === '1';
    const addressOk = !!rawAddress && /^0x[0-9a-fA-F]{40}$/.test(rawAddress);
    this.enabled = wanted && addressOk && !!privateKey && !!rpcUrl;

    if (wanted && !this.enabled) {
      this.logger.error(
        'BURN_LOCK_ENABLED is set but BURN_LOCK_ADDRESS / BURN_LOCK_KEEPER_PRIVATE_KEY / EVM_RPC_URL is missing or invalid — keeper disabled.'
      );
    }
    if (!this.enabled) return;

    this.address = getAddress(rawAddress as string);
    this.account = privateKeyToAccount(privateKey as Hex);

    const chain = defineChain({
      id: chainId,
      name: 'Robinhood Chain',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl as string] } },
    });
    this.publicClient = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 2 }) });
    this.walletClient = createWalletClient({ account: this.account, chain, transport: http(rpcUrl) });
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) return;
    this.logger.log(`Burn-lock keeper on ${this.address} as ${this.account?.address}`);
    // Catch up straight away after a deploy/restart instead of waiting for the next tick.
    void this.runBurn();
  }

  @Cron('0 0 */2 * * *', { name: 'burn-lock-daily-burn' })
  async scheduledBurn(): Promise<void> {
    await this.runBurn();
  }

  async runBurn(): Promise<BurnRunResult> {
    if (!this.enabled) return { status: 'disabled' };
    if (this.running) return { status: 'busy' };
    this.running = true;
    try {
      return await this.tryBurn();
    } catch (err) {
      const error = (err as Error).message;
      this.logger.error(`Burn-lock run failed: ${error}`);
      return { status: 'failed', error };
    } finally {
      this.running = false;
    }
  }

  private async tryBurn(): Promise<BurnRunResult> {
    const read = (functionName: 'started' | 'burnable' | 'nextBurnAt'): Promise<unknown> =>
      this.publicClient.readContract({ address: this.address, abi: BURN_LOCK_ABI, functionName });

    const [started, burnable, nextBurnAt] = (await Promise.all([
      read('started'),
      read('burnable'),
      read('nextBurnAt'),
    ])) as [boolean, bigint, bigint];

    if (!started) return { status: 'not-started', nextBurnAt: Number(nextBurnAt) };
    if (burnable === 0n) return { status: 'nothing-due', nextBurnAt: Number(nextBurnAt) };

    await this.warnIfLowBalance();

    // Simulate first: if another instance already burned, this reverts with
    // NothingToBurn and we skip without spending gas.
    let request: unknown;
    try {
      ({ request } = await this.publicClient.simulateContract({
        account: this.account,
        address: this.address,
        abi: BURN_LOCK_ABI,
        functionName: 'burn',
      }));
    } catch (err) {
      if (/NothingToBurn/.test((err as Error).message)) {
        return { status: 'nothing-due', nextBurnAt: Number(nextBurnAt) };
      }
      throw err;
    }

    const hash: Hex = await this.walletClient.writeContract(request);
    this.logger.log(`Burn-lock burn sent: ${hash} (${formatEther(burnable)} L4VA due)`);

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== 'success') {
      throw new Error(`Burn tx ${hash} reverted`);
    }

    const fee = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice ?? 0n);
    this.logger.log(
      `Burned ${formatEther(burnable)} L4VA in ${hash} — gas ${receipt.gasUsed}, fee ${formatEther(fee)} ETH`
    );
    return { status: 'burned', hash, amount: burnable.toString() };
  }

  private async warnIfLowBalance(): Promise<void> {
    const balance: bigint = await this.publicClient.getBalance({ address: this.account?.address });
    if (balance < LOW_BALANCE_WEI) {
      this.logger.warn(`Burn-lock keeper ${this.account?.address} low on gas: ${formatEther(balance)} ETH`);
    }
  }
}
