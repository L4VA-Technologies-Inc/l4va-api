import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { createPublicClient, defineChain, http, getAddress, type Address } from 'viem';

import { PRESALE_ABI } from './presale.abi';

const MULTICALL3_ADDRESS: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
const LOG_CHUNK_BLOCKS = 50_000n;
const MAX_FEED_ROWS = 50;
/** Cap the first-run backfill so a bad deploy-block can't trigger a full-chain walk. */
const MAX_LOOKBACK_BLOCKS = 500_000n;

const STATE_FIELDS = [
  'phase',
  'totalSold',
  'hardCapL4va',
  'remainingL4va',
  'ethUsdPrice',
  'usdPriceWl',
  'usdPricePublic',
  'maxPerWalletWl',
  'maxPerWalletPublic',
  'minPerPurchaseWl',
  'minPerPurchasePublic',
  'wlEndsAt',
  'publicEndsAt',
] as const;

type StateField = (typeof STATE_FIELDS)[number];

export interface PresaleState {
  configured: boolean;
  address: string | null;
  chainId: number;
  phase: number;
  /** uint256 values as decimal strings (wei / 1e18-scaled USD). */
  totalSold: string;
  hardCapL4va: string;
  remainingL4va: string;
  ethUsdPrice: string;
  usdPriceWl: string;
  usdPricePublic: string;
  maxPerWalletWl: string;
  maxPerWalletPublic: string;
  minPerPurchaseWl: string;
  minPerPurchasePublic: string;
  /** Unix seconds; "0" means the phase closes manually rather than on a clock. */
  wlEndsAt: string;
  publicEndsAt: string;
  updatedAt: number | null;
}

export interface PurchaseRow {
  txHash: string;
  logIndex: number;
  blockNumber: string;
  buyer: string;
  l4vaAmount: string;
  ethPaid: string;
  /** Block timestamp in ms, resolved lazily; null until known. */
  timestamp: number | null;
}

export interface PurchaseFeed {
  configured: boolean;
  items: PurchaseRow[];
  totalL4va: string;
  totalEth: string;
  count: number;
  updatedAt: number | null;
}

/**
 * Single server-side poller for the L4VAPresale contract on Robinhood Chain.
 *
 * The l4va-org landing page used to read the contract directly from every
 * visitor's browser, which rate-limited (429) the public RPC on any real
 * traffic. This service polls once and serves cached JSON so the chain sees
 * one client regardless of how many people are on the page.
 */
@Injectable()
export class PresaleService implements OnModuleInit {
  private readonly logger = new Logger(PresaleService.name);

  /** eth_call / multicall — prefers Alchemy (reliable, no 429). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly readClient: any;
  /** eth_getLogs — needs a wide block range, so never Alchemy free tier (10-block cap). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly logClient: any;
  private readonly address: Address | null;
  private readonly chainId: number;
  private readonly deployBlock: bigint;
  private readonly rpcLabel: string;

  private state: PresaleState;
  private feed: PurchaseFeed;

  private lastScannedBlock: bigint | null = null;
  private totalL4vaAllTime = 0n;
  private totalEthAllTime = 0n;
  private readonly rows: PurchaseRow[] = [];
  private readonly blockTimes = new Map<string, number>();
  private scanning = false;

  constructor(private readonly configService: ConfigService) {
    this.chainId = Number(this.configService.get<string>('EVM_CHAIN_ID') || '46630');
    this.deployBlock = this.parseBigint(this.configService.get<string>('PRESALE_DEPLOY_BLOCK'), 0n);

    const rawAddress = this.configService.get<string>('PRESALE_ADDRESS')?.trim();
    this.address = rawAddress && /^0x[0-9a-fA-F]{40}$/.test(rawAddress) ? getAddress(rawAddress) : null;

    const read = this.resolveReadRpc();
    const log = this.resolveLogRpc();
    this.rpcLabel = `reads=${read.label}, logs=${log.label}`;

    const chain = defineChain({
      id: this.chainId,
      name: 'Robinhood Chain',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [read.url] } },
      contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
    });

    this.readClient = createPublicClient({
      chain,
      transport: http(read.url, { batch: true, retryCount: 2 }),
    });
    this.logClient = createPublicClient({
      chain,
      transport: http(log.url, { batch: true, retryCount: 1 }),
    });

    this.state = this.emptyState();
    this.feed = { configured: !!this.address, items: [], totalL4va: '0', totalEth: '0', count: 0, updatedAt: null };
  }

  async onModuleInit(): Promise<void> {
    if (!this.address) {
      this.logger.warn('PRESALE_ADDRESS not configured — presale endpoints will report unconfigured.');
      return;
    }
    this.logger.log(`Presale poller starting — contract ${this.address} on chain ${this.chainId} via ${this.rpcLabel}`);
    await Promise.allSettled([this.refreshState(), this.refreshPurchases()]);
  }

  // ── Public accessors (cached, JSON-safe) ──────────────────────────────────

  getState(): PresaleState {
    return this.state;
  }

  getPurchases(): PurchaseFeed {
    return this.feed;
  }

  // ── Poll loops ────────────────────────────────────────────────────────────

  @Cron('*/10 * * * * *', { name: 'presale-state' })
  async refreshState(): Promise<void> {
    if (!this.address) return;
    try {
      const contracts = STATE_FIELDS.map(functionName => ({
        address: this.address as Address,
        abi: PRESALE_ABI,
        functionName,
      }));
      const results = await this.readClient.multicall({ contracts, allowFailure: true });

      const next = this.emptyState();
      const nextRecord = next as unknown as Record<StateField, string | number>;
      const prevRecord = this.state as unknown as Record<StateField, string | number>;
      let anyOk = false;
      STATE_FIELDS.forEach((field: StateField, i: number) => {
        const r = results[i];
        if (r?.status === 'success' && r.result !== undefined && r.result !== null) {
          anyOk = true;
          nextRecord[field] = field === 'phase' ? Number(r.result) : (r.result as bigint).toString();
        } else if (this.state.updatedAt) {
          // Keep the last good value for a field that reverted this round.
          nextRecord[field] = prevRecord[field];
        }
      });

      if (!anyOk) {
        this.logger.warn('Presale state multicall returned no successful reads; keeping previous snapshot.');
        return;
      }
      next.updatedAt = Date.now();
      this.state = next;
    } catch (err) {
      this.logger.error(`refreshState failed: ${(err as Error).message}`);
    }
  }

  @Cron('*/20 * * * * *', { name: 'presale-purchases' })
  async refreshPurchases(): Promise<void> {
    if (!this.address || this.scanning) return;
    this.scanning = true;
    try {
      const latest: bigint = await this.logClient.getBlockNumber();

      let from: bigint;
      if (this.lastScannedBlock === null) {
        const floor = latest > MAX_LOOKBACK_BLOCKS ? latest - MAX_LOOKBACK_BLOCKS : 0n;
        from = this.deployBlock > floor ? this.deployBlock : floor;
      } else {
        from = this.lastScannedBlock + 1n;
      }
      if (from > latest) {
        this.scanning = false;
        return;
      }

      const fresh: PurchaseRow[] = [];
      let cursor = from;
      while (cursor <= latest) {
        const to = cursor + LOG_CHUNK_BLOCKS > latest ? latest : cursor + LOG_CHUNK_BLOCKS;
        const logs = await this.logClient.getContractEvents({
          address: this.address,
          abi: PRESALE_ABI,
          eventName: 'Purchased',
          fromBlock: cursor,
          toBlock: to,
        });
        for (const log of logs) {
          fresh.push({
            txHash: log.transactionHash,
            logIndex: Number(log.logIndex),
            blockNumber: (log.blockNumber as bigint).toString(),
            buyer: log.args?.buyer ?? '0x',
            l4vaAmount: (log.args?.l4vaAmount ?? 0n).toString(),
            ethPaid: (log.args?.ethPaid ?? 0n).toString(),
            timestamp: null,
          });
        }
        cursor = to + 1n;
      }
      this.lastScannedBlock = latest;

      if (fresh.length) {
        const seen = new Set(this.rows.map(r => `${r.txHash}-${r.logIndex}`));
        for (const row of fresh) {
          const key = `${row.txHash}-${row.logIndex}`;
          if (seen.has(key)) continue;
          seen.add(key);
          this.totalL4vaAllTime += BigInt(row.l4vaAmount);
          this.totalEthAllTime += BigInt(row.ethPaid);
          this.rows.unshift(row);
        }
        this.rows.sort((a, b) => {
          const bn = BigInt(b.blockNumber) - BigInt(a.blockNumber);
          if (bn !== 0n) return bn > 0n ? 1 : -1;
          return b.logIndex - a.logIndex;
        });
        this.rows.length = Math.min(this.rows.length, MAX_FEED_ROWS);
      }

      await this.resolveTimestamps();

      this.feed = {
        configured: true,
        items: this.rows.map(r => ({ ...r, timestamp: this.blockTimes.get(r.blockNumber) ?? null })),
        totalL4va: this.totalL4vaAllTime.toString(),
        totalEth: this.totalEthAllTime.toString(),
        count: this.rows.length,
        updatedAt: Date.now(),
      };
    } catch (err) {
      this.logger.error(`refreshPurchases failed: ${(err as Error).message}`);
    } finally {
      this.scanning = false;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async resolveTimestamps(): Promise<void> {
    const missing = this.rows
      .map(r => r.blockNumber)
      .filter(bn => !this.blockTimes.has(bn))
      .slice(0, 20);
    if (!missing.length) return;
    await Promise.all(
      missing.map(async bn => {
        try {
          const block = await this.logClient.getBlock({ blockNumber: BigInt(bn) });
          this.blockTimes.set(bn, Number(block.timestamp) * 1000);
        } catch {
          /* leave unresolved; retried next poll */
        }
      })
    );
  }

  private readonly PUBLIC_RPC = 'https://rpc.testnet.chain.robinhood.com';

  /** For eth_call / multicall — Alchemy first (reliable, no 429). */
  private resolveReadRpc(): { url: string; label: string } {
    const explicit = this.configService.get<string>('PRESALE_ALCHEMY_RPC_URL')?.trim();
    if (explicit) return { url: explicit.replace(/\/$/, ''), label: 'alchemy(explicit)' };

    const apiKey = this.configService.get<string>('ALCHEMY_API_KEY')?.trim();
    const network = this.configService.get<string>('ALCHEMY_NETWORK')?.trim().toLowerCase();
    if (apiKey && network) {
      return { url: `https://${network}.g.alchemy.com/v2/${apiKey}`, label: `alchemy(${network})` };
    }

    const evmRpc = this.configService.get<string>('EVM_RPC_URL')?.trim();
    return evmRpc ? { url: evmRpc, label: 'EVM_RPC_URL' } : { url: this.PUBLIC_RPC, label: 'public' };
  }

  /**
   * For eth_getLogs — must allow a wide fromBlock/toBlock range. Alchemy's free
   * tier caps this at 10 blocks, so prefer EVM_RPC_URL / the public RPC, and
   * only use Alchemy when an explicit (paid) endpoint is provided.
   */
  private resolveLogRpc(): { url: string; label: string } {
    const evmRpc = this.configService.get<string>('EVM_RPC_URL')?.trim();
    if (evmRpc && !/\.g\.alchemy\.com/.test(evmRpc)) return { url: evmRpc, label: 'EVM_RPC_URL' };

    const explicit = this.configService.get<string>('PRESALE_LOG_RPC_URL')?.trim();
    if (explicit) return { url: explicit.replace(/\/$/, ''), label: 'PRESALE_LOG_RPC_URL' };

    return { url: this.PUBLIC_RPC, label: 'public' };
  }

  private parseBigint(raw: string | undefined, fallback: bigint): bigint {
    if (!raw) return fallback;
    try {
      const v = BigInt(raw.trim());
      return v >= 0n ? v : fallback;
    } catch {
      return fallback;
    }
  }

  private emptyState(): PresaleState {
    return {
      configured: !!this.address,
      address: this.address,
      chainId: this.chainId,
      phase: 0,
      totalSold: '0',
      hardCapL4va: '0',
      remainingL4va: '0',
      ethUsdPrice: '0',
      usdPriceWl: '0',
      usdPricePublic: '0',
      maxPerWalletWl: '0',
      maxPerWalletPublic: '0',
      minPerPurchaseWl: '0',
      minPerPurchasePublic: '0',
      wlEndsAt: '0',
      publicEndsAt: '0',
      updatedAt: null,
    };
  }
}
