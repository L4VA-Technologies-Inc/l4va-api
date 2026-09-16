import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { encodeAbiParameters, isAddress, keccak256, parseAbi, type Address, type Hex } from 'viem';

import {
  computeAllocation,
  planBuys,
  planSells,
  validateWeights,
  type HoldingValue,
  type PlanOptions,
  type PortfolioState,
  type WeightTarget,
} from './index-rebalance.planner';
import { IndexSwapRouteService, NATIVE } from './index-swap-route.service';

import { EvmIndexRebalance, IndexRebalancePhase } from '@/database/evm-index-rebalance.entity';
import { Proposal } from '@/database/proposal.entity';
import { Vault } from '@/database/vault.entity';
import { EvmContractReader } from '@/modules/vaults/processing-tx/onchain/evm-contract-reader.service';
import { EvmSwapService } from '@/modules/vaults/processing-tx/onchain/evm-swap.service';
import { VAULT_ABI } from '@/modules/vaults/processing-tx/onchain/vault.abi';
import {
  BPS,
  INDEX_DEFAULT_DRIFT_TOLERANCE_BPS,
  INDEX_DEFAULT_SLIPPAGE_BPS,
  INDEX_MAX_ASSETS,
  INDEX_MIN_WEIGHT_BPS,
  IndexConfig,
  IndexLegSide,
  IndexLegStatus,
  IndexRebalanceLeg,
  IndexRebalanceStatus,
  IndexRebalanceTrigger,
  IndexTarget,
  VaultArchetype,
} from '@/types/index-vault.types';
import { ChainType, VaultStatus } from '@/types/vault.types';

const ERC20_METADATA_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
]);

/** A 0.001 ETH leg is not worth its gas. */
const MIN_TRADE_NATIVE = 10n ** 15n;
const SWAP_DEADLINE_SECONDS = 600n;
const PORTFOLIO_CACHE_MS = 60_000;
const MAX_AUTO_ATTEMPTS = 3;
const AUTO_RETRY_BACKOFF_MS = 10 * 60_000;
const STALE_EXECUTING_MS = 30 * 60_000;

export interface BasketItemInput {
  assetAddress: string;
  weightBps: number;
  symbol?: string;
  name?: string;
  image?: string | null;
}

export interface IndexPortfolioAsset {
  assetAddress: string;
  symbol: string;
  name: string | null;
  image: string | null;
  decimals: number;
  inBasket: boolean;
  weightBps: number;
  targetBps: number;
  actualBps: number;
  driftBps: number;
  balance: string;
  valueNative: string;
}

export interface IndexPortfolio {
  navNative: string;
  reserve: { targetBps: number; actualBps: number; valueNative: string };
  assets: IndexPortfolioAsset[];
  pricedAt: string;
  /** Set when the portfolio could not be read; the basket itself is still returned. */
  error?: string;
}

@Injectable()
export class IndexVaultService {
  private readonly logger = new Logger(IndexVaultService.name);
  private readonly portfolioCache = new Map<string, { at: number; data: IndexPortfolio }>();
  private readonly running = new Set<string>();

  constructor(
    @InjectRepository(Vault) private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(EvmIndexRebalance) private readonly rebalanceRepository: Repository<EvmIndexRebalance>,
    private readonly contractReader: EvmContractReader,
    private readonly swapService: EvmSwapService,
    private readonly routeService: IndexSwapRouteService
  ) {}

  // ---------------------------------------------------------------------------
  // Basket definition
  // ---------------------------------------------------------------------------

  /**
   * Validate a basket and resolve each asset's decimals from chain. Symbol and
   * name come from chain too when the caller did not supply them.
   *
   * Every asset must be quotable from native through the configured swap
   * adapter — a basket the vault cannot buy would lock contributors' ETH in a
   * vault that never becomes an index.
   */
  async resolveBasket(items: BasketItemInput[]): Promise<IndexTarget[]> {
    const error = validateWeights({
      weightsBps: items.map(i => Number(i.weightBps)),
      maxAssets: INDEX_MAX_ASSETS,
      minWeightBps: INDEX_MIN_WEIGHT_BPS,
    });
    if (error) throw new BadRequestException(error);

    const seen = new Set<string>();
    for (const item of items) {
      const address = item.assetAddress?.toLowerCase();
      if (!address || !isAddress(address) || address === NATIVE) {
        throw new BadRequestException(`Invalid basket asset address: ${item.assetAddress}`);
      }
      if (seen.has(address)) throw new BadRequestException(`Asset ${address} appears twice in the basket`);
      seen.add(address);
    }

    if (!this.routeService.adapter) {
      throw new BadRequestException('Index vaults are not enabled: no swap adapter is configured');
    }

    return Promise.all(
      items.map(async item => {
        const address = item.assetAddress.toLowerCase() as Address;
        let decimals: number;
        try {
          decimals = Number(
            await this.contractReader.publicClient.readContract({
              address,
              abi: ERC20_METADATA_ABI,
              functionName: 'decimals',
            })
          );
        } catch {
          throw new BadRequestException(`${address} is not an ERC-20 token on this chain`);
        }

        const symbol =
          item.symbol ||
          ((await this.contractReader.publicClient
            .readContract({ address, abi: ERC20_METADATA_ABI, functionName: 'symbol' })
            .catch(() => null)) as string | null) ||
          address.slice(0, 8);
        const name =
          item.name ||
          ((await this.contractReader.publicClient
            .readContract({ address, abi: ERC20_METADATA_ABI, functionName: 'name' })
            .catch(() => null)) as string | null);

        try {
          const probe = await this.routeService.quote(NATIVE, address, MIN_TRADE_NATIVE);
          if (probe.amountOut === 0n) throw new Error('zero output');
        } catch (err) {
          throw new BadRequestException(
            `${symbol} (${address}) cannot be bought through the vault swap adapter: ${(err as Error).message}`
          );
        }

        return {
          assetAddress: address,
          symbol,
          name,
          decimals,
          image: item.image ?? null,
          weightBps: Number(item.weightBps),
        };
      })
    );
  }

  buildConfig(
    targets: IndexTarget[],
    reserveBps: number,
    previous?: IndexConfig | null,
    proposalId?: string
  ): IndexConfig {
    if (!Number.isInteger(reserveBps) || reserveBps < 0 || reserveBps > 5000) {
      throw new BadRequestException('The cash reserve must be between 0% and 50%');
    }
    return {
      targets,
      reserveBps,
      driftToleranceBps: previous?.driftToleranceBps ?? INDEX_DEFAULT_DRIFT_TOLERANCE_BPS,
      slippageBps: previous?.slippageBps ?? INDEX_DEFAULT_SLIPPAGE_BPS,
      version: (previous?.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      updatedByProposalId: proposalId ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Read side
  // ---------------------------------------------------------------------------

  async getOverview(vaultId: string): Promise<{
    vaultArchetype: VaultArchetype;
    config: IndexConfig | null;
    portfolio: IndexPortfolio | null;
    rebalances: ReturnType<IndexVaultService['serializeRebalance']>[];
  }> {
    const vault = await this.requireIndexVault(vaultId);
    const hasHoldings =
      !!vault.contract_address &&
      [VaultStatus.locked, VaultStatus.expansion, VaultStatus.acquire_expansion, VaultStatus.terminating].includes(
        vault.vault_status
      );

    const [portfolio, rebalances] = await Promise.all([
      hasHoldings ? this.getPortfolio(vault) : Promise.resolve(null),
      this.rebalanceRepository.find({ where: { vault_id: vaultId }, order: { created_at: 'DESC' }, take: 10 }),
    ]);

    return {
      vaultArchetype: vault.vault_archetype,
      config: vault.index_config ?? null,
      portfolio,
      rebalances: rebalances.map(r => this.serializeRebalance(r)),
    };
  }

  /**
   * Dry-run a re-weight against the live portfolio. The buy side assumes every
   * sell fills at its quote, so it is an estimate, not an execution plan.
   */
  async previewReweight(
    vaultId: string,
    items: BasketItemInput[],
    reserveBps: number
  ): Promise<{
    sells: { asset: string; amountIn: string; valueNative: string; exit: boolean }[];
    buys: { asset: string; nativeIn: string }[];
  }> {
    const vault = await this.requireIndexVault(vaultId);
    if (!vault.contract_address) throw new BadRequestException('Vault is not deployed yet');
    const error = validateWeights({
      weightsBps: items.map(i => Number(i.weightBps)),
      maxAssets: INDEX_MAX_ASSETS,
      minWeightBps: INDEX_MIN_WEIGHT_BPS,
    });
    if (error) throw new BadRequestException(error);

    const targets: WeightTarget[] = items.map(i => ({ asset: i.assetAddress.toLowerCase(), weightBps: i.weightBps }));
    const opts = this.planOptions(vault.index_config, reserveBps);
    const state = await this.readState(
      vault.contract_address as Address,
      targets.map(t => t.asset as Address)
    );

    const sells = planSells(state, targets, opts);
    const afterSells: PortfolioState = {
      nativeAvailable: state.nativeAvailable + sells.reduce((s, x) => s + x.valueNative, 0n),
      holdings: state.holdings.map(h => {
        const sold = sells.find(s => s.asset === h.asset);
        if (!sold) return h;
        return { asset: h.asset, balance: h.balance - sold.amountIn, valueNative: h.valueNative - sold.valueNative };
      }),
    };
    const buys = planBuys(afterSells, targets, opts);

    return {
      sells: sells.map(s => ({
        asset: s.asset,
        amountIn: s.amountIn.toString(),
        valueNative: s.valueNative.toString(),
        exit: s.exit,
      })),
      buys: buys.map(b => ({ asset: b.asset, nativeIn: b.nativeIn.toString() })),
    };
  }

  private async getPortfolio(vault: Vault): Promise<IndexPortfolio> {
    const cached = this.portfolioCache.get(vault.id);
    if (cached && Date.now() - cached.at < PORTFOLIO_CACHE_MS) return cached.data;

    const config = vault.index_config;
    const targets = config?.targets ?? [];
    const reserveBps = config?.reserveBps ?? 0;

    try {
      const state = await this.readState(
        vault.contract_address as Address,
        targets.map(t => t.assetAddress as Address)
      );
      const allocation = computeAllocation(
        state,
        targets.map(t => ({ asset: t.assetAddress, weightBps: t.weightBps })),
        reserveBps
      );
      const byAddress = new Map(targets.map(t => [t.assetAddress, t]));
      const balances = new Map(state.holdings.map(h => [h.asset, h.balance]));

      const data: IndexPortfolio = {
        navNative: allocation.nav.toString(),
        reserve: {
          targetBps: reserveBps,
          actualBps: allocation.reserveActualBps,
          valueNative: state.nativeAvailable.toString(),
        },
        assets: allocation.rows.map(row => {
          const target = byAddress.get(row.asset);
          return {
            assetAddress: row.asset,
            symbol: target?.symbol ?? row.asset.slice(0, 8),
            name: target?.name ?? null,
            image: target?.image ?? null,
            decimals: target?.decimals ?? 18,
            inBasket: !!target,
            weightBps: target?.weightBps ?? 0,
            targetBps: row.targetBps,
            actualBps: row.actualBps,
            driftBps: row.driftBps,
            balance: (balances.get(row.asset) ?? 0n).toString(),
            valueNative: row.valueNative.toString(),
          };
        }),
        pricedAt: new Date().toISOString(),
      };
      this.portfolioCache.set(vault.id, { at: Date.now(), data });
      return data;
    } catch (err) {
      this.logger.warn(`Index portfolio read failed for vault ${vault.id}: ${(err as Error).message}`);
      return {
        navNative: '0',
        reserve: { targetBps: reserveBps, actualBps: 0, valueNative: '0' },
        assets: [],
        pricedAt: new Date().toISOString(),
        error: 'Live holdings are temporarily unavailable',
      };
    }
  }

  /**
   * Free native plus every ERC-20 the vault could hold a basket position in:
   * the targets and anything already in custody. The vault's own token is never
   * a holding. A basket asset that cannot be priced aborts — trading on a
   * guessed value would mis-size every other leg.
   */
  private async readState(vaultAddress: Address, basketAssets: Address[]): Promise<PortfolioState> {
    const client = this.contractReader.publicClient;
    const [nativeAvailable, custody, vaultToken] = (await Promise.all([
      client.readContract({ address: vaultAddress, abi: VAULT_ABI, functionName: 'availableNativeForOperations' }),
      client.readContract({ address: vaultAddress, abi: VAULT_ABI, functionName: 'custodyTokens' }),
      client.readContract({ address: vaultAddress, abi: VAULT_ABI, functionName: 'vaultToken' }),
    ])) as [bigint, Address[], Address];

    const basket = new Set(basketAssets.map(a => a.toLowerCase()));
    const tokens = [...new Set([...basket, ...custody.map(a => a.toLowerCase())])].filter(
      t => t !== vaultToken.toLowerCase()
    ) as Address[];

    const holdings: HoldingValue[] = [];
    for (const token of tokens) {
      const balance = (await client.readContract({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: 'availableErc20ForOperations',
        args: [token],
      })) as bigint;
      if (balance === 0n) {
        if (basket.has(token)) holdings.push({ asset: token, balance, valueNative: 0n });
        continue;
      }
      try {
        holdings.push({ asset: token, balance, valueNative: await this.routeService.valueInNative(token, balance) });
      } catch (err) {
        if (basket.has(token)) {
          throw new Error(`Cannot price basket asset ${token}: ${(err as Error).message}`);
        }
        this.logger.warn(`Ignoring unpriceable custody token ${token} in ${vaultAddress}: ${(err as Error).message}`);
      }
    }

    return { nativeAvailable, holdings };
  }

  // ---------------------------------------------------------------------------
  // Execution
  // ---------------------------------------------------------------------------

  /**
   * Cron entry point: buy the basket for every index vault whose latest cycle
   * locked and has not been invested yet. Also covers acquire-expansion cycles,
   * since the idempotency key is per cycle.
   */
  async runPendingInitialBuys(): Promise<void> {
    const vaults = await this.vaultRepository.find({
      where: {
        chain_type: ChainType.robinhood,
        vault_archetype: VaultArchetype.index_weighted,
        vault_status: VaultStatus.locked,
        contract_address: Not(IsNull()),
        evm_root_committed_at: Not(IsNull()),
      },
      select: ['id', 'evm_current_cycle_id'],
    });

    for (const vault of vaults) {
      if (!vault.evm_current_cycle_id) continue;
      const key = `initial:cycle:${vault.evm_current_cycle_id}`;
      const existing = await this.rebalanceRepository.findOne({ where: { vault_id: vault.id, idempotency_key: key } });
      if (existing?.status === IndexRebalanceStatus.completed) continue;
      if (existing?.status === IndexRebalanceStatus.failed) {
        const cooledDown = Date.now() - existing.updated_at.getTime() > AUTO_RETRY_BACKOFF_MS;
        if (existing.attempts >= MAX_AUTO_ATTEMPTS || !cooledDown) continue;
      }

      try {
        await this.runRebalance(vault.id, IndexRebalanceTrigger.initial_buy, key);
      } catch (err) {
        this.logger.error(`Index initial buy failed for vault ${vault.id}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Execute a passed INDEX_REWEIGHT proposal: adopt the new basket, then trade
   * to it. Safe to call again after a failure — the config bump is keyed to the
   * proposal and the trades resume from their persisted legs.
   */
  async executeReweightProposal(proposal: Proposal): Promise<boolean> {
    const payload = proposal.metadata?.indexReweight;
    if (!payload?.targets?.length) {
      this.logger.error(`Proposal ${proposal.id}: missing indexReweight metadata`);
      return false;
    }

    const vault = await this.requireIndexVault(proposal.vaultId);
    if (vault.index_config?.updatedByProposalId !== proposal.id) {
      const config = this.buildConfig(payload.targets, payload.reserveBps, vault.index_config, proposal.id);
      await this.vaultRepository.update({ id: vault.id }, { index_config: config });
      this.portfolioCache.delete(vault.id);
    }

    try {
      const run = await this.runRebalance(
        vault.id,
        IndexRebalanceTrigger.governance_reweight,
        `proposal:${proposal.id}`,
        proposal.id
      );
      return run.status === IndexRebalanceStatus.completed;
    } catch (err) {
      this.logger.error(`Proposal ${proposal.id}: re-weight trades failed — ${(err as Error).message}`);
      return false;
    }
  }

  /** Operator retry of a failed run, ignoring the automatic attempt cap. */
  async retryRebalance(
    vaultId: string,
    rebalanceId: string
  ): Promise<ReturnType<IndexVaultService['serializeRebalance']>> {
    const run = await this.rebalanceRepository.findOne({ where: { id: rebalanceId, vault_id: vaultId } });
    if (!run) throw new NotFoundException('Rebalance not found');
    if (run.status === IndexRebalanceStatus.completed) return this.serializeRebalance(run);
    const result = await this.runRebalance(vaultId, run.trigger, run.idempotency_key, run.proposal_id ?? undefined);
    return this.serializeRebalance(result);
  }

  async runRebalance(
    vaultId: string,
    trigger: IndexRebalanceTrigger,
    idempotencyKey: string,
    proposalId?: string
  ): Promise<EvmIndexRebalance> {
    const vault = await this.requireIndexVault(vaultId);
    const config = vault.index_config;
    if (!config?.targets?.length) throw new Error(`Vault ${vaultId} has no index basket configured`);
    if (!vault.contract_address) throw new Error(`Vault ${vaultId} has no contract address`);
    const vaultAddress = vault.contract_address as Address;
    const adapter = this.routeService.requireAdapter();

    const lockKey = `${vaultId}`;
    if (this.running.has(lockKey)) throw new Error(`A rebalance is already running for vault ${vaultId}`);
    this.running.add(lockKey);

    try {
      let run = await this.rebalanceRepository.findOne({
        where: { vault_id: vaultId, idempotency_key: idempotencyKey },
      });
      if (!run) {
        run = await this.rebalanceRepository.save(
          this.rebalanceRepository.create({
            vault_id: vaultId,
            idempotency_key: idempotencyKey,
            trigger,
            proposal_id: proposalId ?? null,
            status: IndexRebalanceStatus.pending,
            phase: IndexRebalancePhase.sells,
            targets: config.targets,
            reserve_bps: config.reserveBps,
            legs: [],
          })
        );
      }
      if (run.status === IndexRebalanceStatus.completed) return run;

      // Runs of one vault must never interleave: each plans from the live
      // portfolio, so two concurrent runs would size trades against balances
      // the other is changing. The in-process lock above only covers this replica.
      const concurrent = await this.rebalanceRepository
        .createQueryBuilder('r')
        .where('r.vault_id = :vaultId AND r.id <> :id', { vaultId, id: run.id })
        .andWhere('r.status = :executing AND r.updated_at >= :stale', {
          executing: IndexRebalanceStatus.executing,
          stale: new Date(Date.now() - STALE_EXECUTING_MS),
        })
        .getCount();
      if (concurrent > 0) throw new Error(`Another rebalance is executing for vault ${vaultId}; retry later`);

      // Cross-replica gate: only one worker may move a run into `executing`. A
      // run stuck in `executing` past the stale window belonged to a crashed
      // worker; its legs are settled against chain before anything re-trades.
      const gate = await this.rebalanceRepository
        .createQueryBuilder()
        .update(EvmIndexRebalance)
        .set({ status: IndexRebalanceStatus.executing, attempts: run.attempts + 1, last_error: null })
        .where('id = :id', { id: run.id })
        .andWhere('(status IN (:...open) OR (status = :executing AND updated_at < :stale))', {
          open: [IndexRebalanceStatus.pending, IndexRebalanceStatus.failed],
          executing: IndexRebalanceStatus.executing,
          stale: new Date(Date.now() - STALE_EXECUTING_MS),
        })
        .execute();
      if ((gate.affected ?? 0) === 0) return run;
      run.status = IndexRebalanceStatus.executing;
      run.attempts += 1;

      try {
        // Vaults from factories older than V8 have no `swap`; fail with the cause
        // rather than a revert from the first view the planner happens to call.
        await this.swapService.isOperationIdUsed(vaultAddress, `0x${'00'.repeat(32)}`).catch(() => {
          throw new Error(
            `Vault ${vaultAddress} has no Vault.swap — it was deployed by a pre-V8 factory. ` +
              'Index vaults need a vault created through the V8+ VaultFactory.'
          );
        });

        const targets = run.targets.map(t => ({ asset: t.assetAddress, weightBps: t.weightBps }));
        const opts = this.planOptions(config, run.reserve_bps);
        const tradeFeeBps = await this.swapService.tradeFeeBps(vaultAddress);

        for (const phase of [IndexRebalancePhase.sells, IndexRebalancePhase.buys]) {
          if (run.phase !== phase) continue;
          const side = phase === IndexRebalancePhase.sells ? IndexLegSide.sell : IndexLegSide.buy;

          await this.settleStaleLegs(run, side, vaultAddress);

          const state = await this.readState(
            vaultAddress,
            targets.map(t => t.asset as Address)
          );
          if (run.nav_native == null) {
            run.nav_native = state.holdings.reduce((s, h) => s + h.valueNative, state.nativeAvailable).toString();
          }

          const planned =
            side === IndexLegSide.sell
              ? planSells(state, targets, opts).map(s => ({
                  assetIn: s.asset,
                  assetOut: NATIVE as string,
                  amountIn: s.amountIn,
                }))
              : planBuys(state, targets, opts).map(b => ({
                  assetIn: NATIVE as string,
                  assetOut: b.asset,
                  amountIn: b.nativeIn,
                }));

          for (const p of planned) {
            const index = run.legs.length;
            run.legs.push({
              index,
              side,
              operationId: this.operationId(vaultId, idempotencyKey, index),
              assetIn: p.assetIn,
              assetOut: p.assetOut,
              amountIn: p.amountIn.toString(),
              status: IndexLegStatus.pending,
            });
          }
          await this.rebalanceRepository.update({ id: run.id }, { legs: run.legs, nav_native: run.nav_native });

          for (const leg of run.legs.filter(l => l.side === side && l.status === IndexLegStatus.pending)) {
            await this.executeLeg(run, leg, vaultId, vaultAddress, adapter, config.slippageBps, tradeFeeBps);
          }

          run.phase = side === IndexLegSide.sell ? IndexRebalancePhase.buys : IndexRebalancePhase.done;
          await this.rebalanceRepository.update({ id: run.id }, { phase: run.phase });
        }

        run.status = IndexRebalanceStatus.completed;
        run.completed_at = new Date();
        await this.rebalanceRepository.update(
          { id: run.id },
          { status: run.status, completed_at: run.completed_at, legs: run.legs }
        );
        this.logger.log(
          `Index rebalance ${run.id} (${idempotencyKey}) completed for vault ${vaultId}: ` +
            `${run.legs.filter(l => l.status === IndexLegStatus.confirmed).length} leg(s) traded`
        );
        return run;
      } catch (err) {
        run.status = IndexRebalanceStatus.failed;
        run.last_error = (err as Error).message.slice(0, 1000);
        await this.rebalanceRepository.update(
          { id: run.id },
          { status: run.status, last_error: run.last_error, legs: run.legs }
        );
        throw err;
      }
    } finally {
      this.running.delete(lockKey);
      this.portfolioCache.delete(vaultId);
    }
  }

  /**
   * Before re-planning a phase, resolve legs left over from a previous attempt.
   * A leg the vault already consumed landed (receipt lost) and is adopted; an
   * unconsumed leg past its deadline can no longer trade and is superseded by
   * the fresh plan.
   */
  private async settleStaleLegs(run: EvmIndexRebalance, side: IndexLegSide, vaultAddress: Address): Promise<void> {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    for (const leg of run.legs) {
      if (leg.side !== side || leg.status === IndexLegStatus.confirmed || leg.status === IndexLegStatus.skipped) {
        continue;
      }
      if (await this.swapService.isOperationIdUsed(vaultAddress, leg.operationId as Hex)) {
        leg.status = IndexLegStatus.confirmed;
        leg.error = 'adopted: operation id already consumed on-chain';
        continue;
      }
      // A leg that was broadcast may still be in the mempool. Replacing it
      // before its deadline could fill both; after the deadline the vault
      // rejects the old transaction, so re-planning is safe.
      if (leg.deadline && BigInt(leg.deadline) >= nowSec) {
        await this.rebalanceRepository.update({ id: run.id }, { legs: run.legs });
        throw new Error(`Leg ${leg.index} may still land until ${leg.deadline}; retry after its deadline`);
      }
      leg.status = IndexLegStatus.skipped;
      leg.error = leg.error ? `superseded after: ${leg.error}` : 'superseded by re-plan';
    }
    await this.rebalanceRepository.update({ id: run.id }, { legs: run.legs });
  }

  private async executeLeg(
    run: EvmIndexRebalance,
    leg: IndexRebalanceLeg,
    vaultId: string,
    vaultAddress: Address,
    adapter: Address,
    slippageBps: number,
    tradeFeeBps: number
  ): Promise<void> {
    const amountIn = BigInt(leg.amountIn);
    const quote = await this.routeService.quote(leg.assetIn as Address, leg.assetOut as Address, amountIn);
    // The vault's floor binds the NET output, after its own trade fee.
    const minAmountOut =
      (((quote.amountOut * BigInt(BPS - slippageBps)) / BigInt(BPS)) * BigInt(BPS - tradeFeeBps)) / BigInt(BPS);

    const deadline = BigInt(Math.floor(Date.now() / 1000)) + SWAP_DEADLINE_SECONDS;
    leg.quotedOut = quote.amountOut.toString();
    leg.minAmountOut = minAmountOut.toString();

    if (minAmountOut === 0n) {
      leg.status = IndexLegStatus.skipped;
      leg.error = 'quote rounds to zero output';
      await this.rebalanceRepository.update({ id: run.id }, { legs: run.legs });
      return;
    }

    leg.deadline = deadline.toString();
    await this.rebalanceRepository.update({ id: run.id }, { legs: run.legs });

    try {
      const result = await this.swapService.swap(vaultId, {
        operationId: leg.operationId as Hex,
        adapter,
        assetIn: leg.assetIn as Address,
        amountIn,
        assetOut: leg.assetOut as Address,
        minAmountOut,
        deadline,
        route: quote.route,
      });
      leg.status = IndexLegStatus.confirmed;
      leg.txHash = result.txHash;
      leg.grossOut = result.grossOut.toString();
      leg.fee = result.fee.toString();
      leg.error = null;
    } catch (err) {
      leg.status = IndexLegStatus.failed;
      leg.error = (err as Error).message.slice(0, 500);
      throw err;
    } finally {
      await this.rebalanceRepository.update({ id: run.id }, { legs: run.legs });
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async requireIndexVault(vaultId: string): Promise<Vault> {
    const vault = await this.vaultRepository.findOne({ where: { id: vaultId } });
    if (!vault) throw new NotFoundException(`Vault ${vaultId} not found`);
    if (vault.vault_archetype !== VaultArchetype.index_weighted) {
      throw new BadRequestException('This vault is not an index-weighted vault');
    }
    return vault;
  }

  private planOptions(config: IndexConfig | null | undefined, reserveBps: number): PlanOptions {
    return {
      reserveBps,
      driftToleranceBps: config?.driftToleranceBps ?? INDEX_DEFAULT_DRIFT_TOLERANCE_BPS,
      minTradeNative: MIN_TRADE_NATIVE,
    };
  }

  private operationId(vaultId: string, key: string, index: number): Hex {
    return keccak256(
      encodeAbiParameters(
        [{ type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'uint256' }],
        ['L4VA.IndexRebalance', vaultId, key, BigInt(index)]
      )
    );
  }

  serializeRebalance(run: EvmIndexRebalance): {
    id: string;
    trigger: IndexRebalanceTrigger;
    proposalId: string | null;
    status: IndexRebalanceStatus;
    phase: IndexRebalancePhase;
    navNative: string | null;
    legs: IndexRebalanceLeg[];
    attempts: number;
    lastError: string | null;
    createdAt: Date;
    completedAt: Date | null;
  } {
    return {
      id: run.id,
      trigger: run.trigger,
      proposalId: run.proposal_id ?? null,
      status: run.status,
      phase: run.phase,
      navNative: run.nav_native ?? null,
      legs: run.legs,
      attempts: run.attempts,
      lastError: run.last_error ?? null,
      createdAt: run.created_at,
      completedAt: run.completed_at ?? null,
    };
  }
}
