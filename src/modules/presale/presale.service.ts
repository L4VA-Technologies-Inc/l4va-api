import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { createPublicClient, defineChain, http, getAddress, type Address } from 'viem';

import { PRESALE_ABI, TRANCHE_COUNT } from './presale.abi';

const MULTICALL3_ADDRESS: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
const DEFAULT_LOG_CHUNK_BLOCKS = 50_000n;
const MAX_FEED_ROWS = 50;
/** First-run backfill cap, used only when PRESALE_DEPLOY_BLOCK is unset. */
const MAX_LOOKBACK_BLOCKS = 500_000n;

/**
 * Scalar reads batched into one multicall. `trancheState` returns a tuple of
 * arrays rather than a single word, so it is appended separately below.
 */
const STATE_FIELDS = [
  'phase',
  'totalSold',
  'hardCapL4va',
  'remainingL4va',
  'ethUsdPrice',
  'currentTranche',
  'remainingInCurrentTranche',
  'wlDiscountBps',
  'minEthTranche1',
  'maxEthTranche1',
  'minEthLate',
  'maxEthLate',
  'saleEndsAt',
  'saleDuration',
] as const;

type StateField = (typeof STATE_FIELDS)[number];

/** Fields that are small enums/indices and stay as JS numbers, not strings. */
const NUMERIC_FIELDS = new Set<StateField>(['phase', 'currentTranche']);

/** One rung of the price ladder. All uint256 values are decimal strings. */
export interface TrancheRow {
  index: number;
  /** USD per 1 L4VA, 1e18-scaled. $0.0027 is "2700000000000". */
  priceUsd: string;
  /** L4VA offered in this tranche (raw 18-dec units). */
  supply: string;
  /** L4VA already sold out of this tranche. */
  sold: string;
}

export interface PresaleState {
  configured: boolean;
  address: string | null;
  chainId: number;
  /** 0 = INACTIVE, 1 = ACTIVE, 2 = ENDED. */
  phase: number;
  /** uint256 values as decimal strings (wei / 1e18-scaled USD). */
  totalSold: string;
  hardCapL4va: string;
  remainingL4va: string;
  ethUsdPrice: string;
  /** 0-based index of the tranche currently being filled. */
  currentTranche: number;
  remainingInCurrentTranche: string;
  /** Whitelist discount in basis points; applies in every tranche. */
  wlDiscountBps: string;
  tranches: TrancheRow[];
  /** ETH contribution band while tranche 1 is active (wei). */
  minEthTranche1: string;
  maxEthTranche1: string;
  /** ETH contribution band from tranche 2 onwards (wei). */
  minEthLate: string;
  maxEthLate: string;
  /** Unix seconds; "0" means the sale closes manually rather than on a clock. */
  saleEndsAt: string;
  saleDuration: string;
  updatedAt: number | null;
}

export interface PurchaseRow {
  txHash: string;
  logIndex: number;
  blockNumber: string;
  buyer: string;
  l4vaAmount: string;
  ethPaid: string;
  /** Tranche the fill started and finished in; they differ on a cross-tranche buy. */
  startTranche: number;
  endTranche: number;
  /** Whether the buyer was whitelisted (and so discounted) at purchase time. */
  whitelisted: boolean;
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
  private readonly logChunkBlocks: bigint;
  private readonly rpcLabel: string;

  private state: PresaleState;
  private feed: PurchaseFeed;

  private lastScannedBlock: bigint | null = null;
  private totalL4vaAllTime = 0n;
  private totalEthAllTime = 0n;
  private readonly rows: PurchaseRow[] = [];
  private readonly blockTimes = new Map<string, number>();
  private scanning = false;
  private refreshingState = false;

  constructor(private readonly configService: ConfigService) {
    // No testnet defaults: a missing chain id or RPC must leave the module
    // unconfigured rather than silently reading another network.
    this.chainId = Number(this.configService.get<string>('EVM_CHAIN_ID') || '0');
    this.deployBlock = this.parseBigint(this.configService.get<string>('PRESALE_DEPLOY_BLOCK'), 0n);
    const chunk = this.parseBigint(
      this.configService.get<string>('PRESALE_LOG_CHUNK_BLOCKS'),
      DEFAULT_LOG_CHUNK_BLOCKS
    );
    this.logChunkBlocks = chunk > 0n ? chunk : DEFAULT_LOG_CHUNK_BLOCKS;

    const read = this.resolveReadRpc();
    const log = this.resolveLogRpc();
    this.rpcLabel = `reads=${read?.label ?? 'none'}, logs=${log?.label ?? 'none'}`;

    const rawAddress = this.configService.get<string>('PRESALE_ADDRESS')?.trim();
    const validAddress = rawAddress && /^0x[0-9a-fA-F]{40}$/.test(rawAddress) ? getAddress(rawAddress) : null;
    this.address = validAddress && this.chainId > 0 && read && log ? validAddress : null;
    if (validAddress && !this.address) {
      this.logger.warn(`PRESALE_ADDRESS set but EVM_CHAIN_ID or RPC missing (${this.rpcLabel}) — presale disabled.`);
    }

    const chain = defineChain({
      id: this.chainId,
      name: 'Robinhood Chain',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: read ? [read.url] : [] } },
      contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
    });

    this.readClient = createPublicClient({
      chain,
      transport: http(read?.url, { batch: true, retryCount: 2 }),
    });
    this.logClient = createPublicClient({
      chain,
      transport: http(log?.url, { batch: true, retryCount: 1 }),
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
    if (!this.address || this.refreshingState) return;
    this.refreshingState = true;
    try {
      const contracts = [...STATE_FIELDS, 'trancheState'].map(functionName => ({
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
          nextRecord[field] = NUMERIC_FIELDS.has(field) ? Number(r.result) : (r.result as bigint).toString();
        } else if (this.state.updatedAt) {
          // Keep the last good value for a field that reverted this round.
          nextRecord[field] = prevRecord[field];
        }
      });

      // `trancheState` is the last entry, decoded out of band because it
      // returns three uint256[4] arrays rather than a single word.
      const ladder = results[STATE_FIELDS.length];
      if (ladder?.status === 'success' && ladder.result) {
        anyOk = true;
        next.tranches = this.toTranches(ladder.result as [bigint[], bigint[], bigint[], number]);
      } else if (this.state.updatedAt) {
        next.tranches = this.state.tranches;
      }

      if (!anyOk) {
        this.logger.warn('Presale state multicall returned no successful reads; keeping previous snapshot.');
        return;
      }
      next.updatedAt = Date.now();
      this.state = next;
    } catch (err) {
      this.logger.error(`refreshState failed: ${(err as Error).message}`);
    } finally {
      this.refreshingState = false;
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
        // With a known deploy block, backfill all of it so the all-time totals
        // survive an API restart. The lookback cap only guards a missing value.
        if (this.deployBlock > 0n) {
          from = this.deployBlock;
        } else {
          from = latest > MAX_LOOKBACK_BLOCKS ? latest - MAX_LOOKBACK_BLOCKS : 0n;
          this.logger.warn('PRESALE_DEPLOY_BLOCK unset — purchase totals only cover the recent lookback window.');
        }
      } else {
        from = this.lastScannedBlock + 1n;
      }
      if (from > latest) return;

      const fresh: PurchaseRow[] = [];
      let cursor = from;
      while (cursor <= latest) {
        const to = cursor + this.logChunkBlocks - 1n > latest ? latest : cursor + this.logChunkBlocks - 1n;
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
            startTranche: Number(log.args?.startTranche ?? 0),
            endTranche: Number(log.args?.endTranche ?? 0),
            whitelisted: Boolean(log.args?.whitelisted),
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

  /** For eth_call / multicall — Alchemy first (reliable, no 429). */
  private resolveReadRpc(): { url: string; label: string } | null {
    const explicit = this.configService.get<string>('PRESALE_ALCHEMY_RPC_URL')?.trim();
    if (explicit) return { url: explicit.replace(/\/$/, ''), label: 'alchemy(explicit)' };

    const apiKey = this.configService.get<string>('ALCHEMY_API_KEY')?.trim();
    const network = this.configService.get<string>('ALCHEMY_NETWORK')?.trim().toLowerCase();
    if (apiKey && network) {
      return { url: `https://${network}.g.alchemy.com/v2/${apiKey}`, label: `alchemy(${network})` };
    }

    const evmRpc = this.configService.get<string>('EVM_RPC_URL')?.trim();
    return evmRpc ? { url: evmRpc, label: 'EVM_RPC_URL' } : null;
  }

  /**
   * For eth_getLogs — must allow a wide fromBlock/toBlock range. Alchemy's free
   * tier caps this at 10 blocks, so an explicit PRESALE_LOG_RPC_URL wins, then
   * EVM_RPC_URL as long as it is not Alchemy.
   */
  private resolveLogRpc(): { url: string; label: string } | null {
    const explicit = this.configService.get<string>('PRESALE_LOG_RPC_URL')?.trim();
    if (explicit) return { url: explicit.replace(/\/$/, ''), label: 'PRESALE_LOG_RPC_URL' };

    const evmRpc = this.configService.get<string>('EVM_RPC_URL')?.trim();
    if (evmRpc && !/\.g\.alchemy\.com/.test(evmRpc)) return { url: evmRpc, label: 'EVM_RPC_URL' };

    return null;
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

  /** Zip the contract's parallel price/supply/sold arrays into one row each. */
  private toTranches(result: [bigint[], bigint[], bigint[], number]): TrancheRow[] {
    const [prices, supplies, sold] = result;
    return Array.from({ length: TRANCHE_COUNT }, (_, index) => ({
      index,
      priceUsd: (prices?.[index] ?? 0n).toString(),
      supply: (supplies?.[index] ?? 0n).toString(),
      sold: (sold?.[index] ?? 0n).toString(),
    }));
  }

  private emptyTranches(): TrancheRow[] {
    return Array.from({ length: TRANCHE_COUNT }, (_, index) => ({
      index,
      priceUsd: '0',
      supply: '0',
      sold: '0',
    }));
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
      currentTranche: 0,
      remainingInCurrentTranche: '0',
      wlDiscountBps: '0',
      tranches: this.emptyTranches(),
      minEthTranche1: '0',
      maxEthTranche1: '0',
      minEthLate: '0',
      maxEthLate: '0',
      saleEndsAt: '0',
      saleDuration: '0',
      updatedAt: null,
    };
  }
}
