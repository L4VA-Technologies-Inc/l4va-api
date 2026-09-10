import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type EntityManager, Repository } from 'typeorm';
import { keccak256, toBytes, type Address, type Hex } from 'viem';

import { EvmAdminSigner, TxRevertedError } from './evm-admin-signer.service';
import { EvmContractReader } from './evm-contract-reader.service';
import { EvmTerminationPreflightService, type TerminationPreflightResult } from './evm-termination-preflight.service';
import {
  computeTerminationRates,
  MAX_TERMINATION_ASSETS,
  MIN_SWEEP_DELAY_SECONDS,
  validateTerminationRates,
  type TerminationRateRow,
} from './evm-termination.formulas';
import { EvmVaultOnchainStatus, VAULT_ABI } from './vault.abi';

import { Asset } from '@/database/asset.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { SystemSettingsService } from '@/modules/globals/system-settings/system-settings.service';
import { AssetStatus } from '@/types/asset.types';
import { EvmReconciliationStatus, TransactionStatus, TransactionType } from '@/types/transaction.types';
import { ChainType, VaultStatus } from '@/types/vault.types';

const NATIVE = '0x0000000000000000000000000000000000000000' as const;

export interface BeginTerminationResult {
  txHash: Hex;
  vtSupply: bigint;
  terminationDeadline: bigint;
  rows: TerminationRateRow[];
  waived: Address[];
}

/** The distributable set read from the vault's own custody registry. */
export interface CustodyPlan {
  totalSupply: bigint;
  rows: TerminationRateRow[];
  /** Assets in custody that cannot be given a rate — must be waived or resolved. */
  undistributable: Array<{ asset: Address; free: bigint; reason: string }>;
}

@Injectable()
export class EvmTerminationService {
  private readonly logger = new Logger(EvmTerminationService.name);

  /**
   * Short-lived cache for {@link getEvmTerminationState}. The endpoint is public
   * (OptionalAuth) and fans out to a dozen-plus contract reads, so without this
   * a page refresh loop would hammer the RPC. 10s is well inside the cadence a
   * claim-window countdown UI needs.
   */
  private readonly stateCache = new Map<string, { at: number; value: unknown }>();
  private static readonly STATE_CACHE_TTL_MS = 10_000;

  constructor(
    @InjectRepository(Vault) private readonly vaultsRepository: Repository<Vault>,
    @InjectRepository(Transaction) private readonly transactionsRepository: Repository<Transaction>,
    private readonly dataSource: DataSource,
    private readonly contractReader: EvmContractReader,
    private readonly adminSigner: EvmAdminSigner,
    private readonly preflight: EvmTerminationPreflightService,
    private readonly systemSettings: SystemSettingsService
  ) {}

  /**
   * Phase 4 step 1: require Locked/Cancelled, no open positions, no NFTs held.
   * Transitions on-chain vault → TerminationPreparing.
   */
  async beginTerminationPreparing(vaultId: string): Promise<{ txHash: Hex }> {
    const vault = await this._requireEvmVault(vaultId);
    const vaultAddress = vault.contract_address as Address;

    const onchainStatus = (await this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'status',
    })) as number;

    if (onchainStatus !== EvmVaultOnchainStatus.Locked && onchainStatus !== EvmVaultOnchainStatus.Cancelled) {
      throw new BadRequestException(
        `Vault ${vaultAddress} is ${EvmVaultOnchainStatus[onchainStatus]}; must be Locked or Cancelled`
      );
    }

    const activePositions = (await this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'activeExternalPositionCount',
    })) as bigint;

    if (activePositions > 0n) {
      throw new BadRequestException(
        `Vault ${vaultAddress} has ${activePositions} active position(s). Close them before terminating.`
      );
    }

    // Strict: this is the point of no return. `TerminationPreparing` has no
    // exit other than `beginTermination` — `openCycle` accepts only
    // Locked/Cancelled — so a vault that enters it and then cannot commit is
    // bricked, not delayed. Refusing here is safe; refusing later is not.
    const pre = await this.preflight.check(vaultAddress, true);
    if (!pre.ok) {
      throw new BadRequestException(
        `Vault ${vaultAddress} failed the termination preflight: ${pre.blockers.join('; ')}`
      );
    }

    return this._sendSimple(
      vaultId,
      vault,
      vaultAddress,
      TransactionType.evmBeginTerminationPreparing,
      'beginTerminationPreparing',
      [],
      'TerminationPrepared',
      null // no DB status transition yet
    );
  }

  /**
   * Build the distributable set from the vault's OWN custody registry.
   *
   * The previous implementation derived this list from `evm_external_positions`
   * where `status = active`, which is not the set of assets the vault holds —
   * it missed contributed ERC-20s, returned underlying, and LP tokens. Against
   * the contract's coverage check that reverts with `TerminationAssetUncovered`,
   * so reading `custodyTokens()` is required, not a cleanup.
   */
  async buildCustodyPlan(vaultAddress: Address): Promise<CustodyPlan> {
    const client = this.contractReader.publicClient;

    const vtAddress = (await client.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'vaultToken',
    })) as Address;

    const totalSupply = (await client.readContract({
      address: vtAddress,
      abi: VAULT_ABI,
      functionName: 'totalSupply',
    })) as bigint;

    if (totalSupply === 0n) {
      throw new BadRequestException(`Vault ${vaultAddress} has zero VT supply; nothing to redeem`);
    }

    const inputs: Array<{ asset: Address; free: bigint }> = [];

    const freeNative = (await client.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'availableNativeForOperations',
    })) as bigint;
    if (freeNative > 0n) inputs.push({ asset: NATIVE, free: freeNative });

    const custodyTokens = (await client.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'custodyTokens',
    })) as Address[];

    for (const token of custodyTokens) {
      const free = (await client.readContract({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: 'availableErc20ForOperations',
        args: [token],
      })) as bigint;
      if (free > 0n) inputs.push({ asset: token, free });
    }

    const { rows, undistributable } = computeTerminationRates(inputs, totalSupply);
    return { totalSupply, rows, undistributable: undistributable as CustodyPlan['undistributable'] };
  }

  /**
   * Commit the redemption rates. Transitions on-chain → Terminating and opens
   * the claim window, which closes at `terminationDeadline`.
   *
   * @param waived assets deliberately excluded from the distribution. Gated
   *        behind `evm_termination_allow_waivers` because the on-chain cap
   *        bounds the count of waived assets, not their value — the authority
   *        can waive something valuable and route it to the treasury.
   */
  async beginTermination(vaultId: string, opts: { waived?: Address[] } = {}): Promise<BeginTerminationResult> {
    const vault = await this._requireEvmVault(vaultId);
    const vaultAddress = vault.contract_address as Address;

    const onchainStatus = (await this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'status',
    })) as number;

    if (onchainStatus !== EvmVaultOnchainStatus.TerminationPreparing) {
      throw new BadRequestException(
        `Vault ${vaultAddress} is ${EvmVaultOnchainStatus[onchainStatus]}; must be TerminationPreparing`
      );
    }

    // Advisory only. The vault is already through the one-way door, so a hard
    // block here would strand it — surface the blockers and proceed.
    let recheck: TerminationPreflightResult | null = null;
    try {
      recheck = await this.preflight.check(vaultAddress, false);
      if (!recheck.ok) {
        this.logger.warn(
          `Vault ${vaultId} pool exposure moved after entering TerminationPreparing: ${recheck.blockers.join('; ')}. ` +
            `Committing anyway — refusing would brick the vault.`
        );
      }
    } catch (err) {
      this.logger.warn(`Vault ${vaultId} pre-commit preflight errored (non-fatal): ${(err as Error).message}`);
    }

    const waived = (opts.waived ?? []).map(a => a.toLowerCase() as Address);
    if (waived.length > 0 && !this.systemSettings.evmTerminationAllowWaivers) {
      throw new BadRequestException(
        'Asset waivers are disabled. A waiver sends an asset to the treasury instead of to holders, and the ' +
          'on-chain limit bounds only how many may be waived, not their value. Define the dust/approval policy ' +
          'and set evm_termination_allow_waivers before using it.'
      );
    }

    const plan = await this.buildCustodyPlan(vaultAddress);
    const waivedSet = new Set(waived);
    const rows = plan.rows.filter(r => !waivedSet.has(r.asset.toLowerCase() as Address));

    // Anything in custody that can neither be rated nor waived would make the
    // on-chain coverage check revert. Fail here with the asset named.
    const uncovered = plan.undistributable.filter(u => !waivedSet.has(u.asset.toLowerCase() as Address));
    if (uncovered.length > 0) {
      throw new BadRequestException(
        `Vault ${vaultAddress} holds assets that can be neither distributed nor waived: ` +
          uncovered.map(u => `${u.asset} (${u.reason}, free=${u.free})`).join(', ')
      );
    }

    const errors = validateTerminationRates(rows);
    if (errors.length > 0) {
      throw new BadRequestException(
        `Termination rates for ${vaultAddress} are invalid: ` + errors.map(e => `${e.asset}: ${e.reason}`).join('; ')
      );
    }
    if (rows.length > MAX_TERMINATION_ASSETS) {
      throw new BadRequestException(
        `Vault ${vaultAddress} has ${rows.length} distributable assets, above the on-chain cap of ` +
          `${MAX_TERMINATION_ASSETS}. Consolidate through an adapter while still Locked, or waive the tail.`
      );
    }

    const sweepDelay = this._sweepDelaySeconds();
    const valuationHash = this._valuationHash(vaultAddress, plan.totalSupply, rows, waived, sweepDelay);

    const adminTx = this.transactionsRepository.create({
      type: TransactionType.evmBeginTermination,
      status: TransactionStatus.pending,
      vault_id: vaultId,
      chain_id: vault.chain_id,
      from_address: this.adminSigner.address,
      to_address: vaultAddress,
      reconciliation_status: EvmReconciliationStatus.pending,
      reconciliation_attempts: 0,
      expected_events: [{ name: 'TerminationCommitted', count: 1 }],
    });
    await this.transactionsRepository.save(adminTx);

    let result: Awaited<ReturnType<EvmAdminSigner['sendAndConfirm']>>;
    try {
      result = await this.adminSigner.sendAndConfirm(
        {
          address: vaultAddress,
          abi: VAULT_ABI,
          functionName: 'beginTermination',
          args: [valuationHash, rows.map(r => r.asset), rows.map(r => r.rate), waived, sweepDelay],
        },
        ['TerminationCommitted'],
        async hash => {
          await this.transactionsRepository.update(
            { id: adminTx.id },
            { tx_hash: hash, status: TransactionStatus.submitted }
          );
        }
      );
    } catch (err) {
      await this._handleBroadcastError(adminTx.id, err, 'beginTermination');
      throw err;
    }

    const evt = result.decodedEvents.find(
      e => e.eventName === 'TerminationCommitted' && e.address.toLowerCase() === vaultAddress.toLowerCase()
    );
    const args = evt?.args as { vtSupply?: bigint; terminationDeadline?: bigint } | undefined;
    const deadline = args?.terminationDeadline ?? 0n;

    await this.dataSource.transaction(async manager => {
      await manager.update(
        Transaction,
        { id: adminTx.id },
        {
          status: TransactionStatus.confirmed,
          reconciliation_status: EvmReconciliationStatus.success,
          reconciled_at: new Date(),
          reconciliation_last_error: null,
        }
      );
      await manager.update(
        Vault,
        { id: vaultId },
        {
          vault_status: VaultStatus.terminating,
          termination_metadata: {
            ...(vault.termination_metadata ?? {}),
            evm: {
              phase: 'claim_window_open',
              valuationHash,
              vtSupply: (args?.vtSupply ?? plan.totalSupply).toString(),
              terminationDeadline: deadline.toString(),
              sweepDelaySeconds: sweepDelay.toString(),
              committedAt: new Date().toISOString(),
              assets: rows.map(r => ({ asset: r.asset, rate: r.rate.toString(), implied: r.implied.toString() })),
              waived,
              preflight: recheck
                ? {
                    ok: recheck.ok,
                    outcome: recheck.discovery.outcome,
                    poolVtBps: recheck.discovery.poolVtBps.toString(),
                    blockers: recheck.blockers,
                  }
                : null,
            },
          },
        }
      );
    });

    this.logger.log(
      `beginTermination confirmed vault=${vaultId} assets=${rows.length} deadline=${deadline} tx=${result.hash}`
    );
    return {
      txHash: result.hash,
      vtSupply: args?.vtSupply ?? plan.totalSupply,
      terminationDeadline: deadline,
      rows,
      waived,
    };
  }

  /**
   * Push a redemption for a holder who has not acted. Pays strictly to
   * `holder` — the contract forbids a recipient override here, so a griefer
   * cannot force a contract wallet to receive a token that blacklists it.
   */
  async redeemFor(vaultId: string, holder: Address): Promise<{ txHash: Hex }> {
    const vault = await this._requireEvmVault(vaultId);
    await this._requireTerminating(vault.contract_address as Address);
    return this._sendSimple(
      vaultId,
      vault,
      vault.contract_address as Address,
      TransactionType.evmRedeemFor,
      'redeemFor',
      [holder],
      'Redeemed',
      null
    );
  }

  /**
   * Stop paying an asset that has broken for EVERYONE (global pause, the vault
   * blacklisted, an always-reverting transfer). Entitlements keep accruing at
   * the committed rate and stay claimable, so this blocks nothing and erases
   * nothing. A per-holder failure needs no deferral — that holder redeems to a
   * different recipient.
   */
  async deferTerminationAsset(vaultId: string, asset: Address): Promise<{ txHash: Hex }> {
    const vault = await this._requireEvmVault(vaultId);
    await this._requireTerminating(vault.contract_address as Address);
    return this._sendSimple(
      vaultId,
      vault,
      vault.contract_address as Address,
      TransactionType.evmDeferTerminationAsset,
      'deferTerminationAsset',
      [asset],
      'TerminationAssetDeferred',
      null
    );
  }

  async resumeTerminationAsset(vaultId: string, asset: Address): Promise<{ txHash: Hex }> {
    const vault = await this._requireEvmVault(vaultId);
    await this._requireTerminating(vault.contract_address as Address);
    return this._sendSimple(
      vaultId,
      vault,
      vault.contract_address as Address,
      TransactionType.evmResumeTerminationAsset,
      'resumeTerminationAsset',
      [asset],
      'TerminationAssetResumed',
      null
    );
  }

  /**
   * Release what nobody claimed to the treasury. Only valid from
   * `terminationDeadline` — the contract has no early-sweep path.
   */
  async sweepTerminationRemainder(vaultId: string, asset: Address): Promise<{ txHash: Hex }> {
    const vault = await this._requireEvmVault(vaultId);
    const vaultAddress = vault.contract_address as Address;

    const deadline = (await this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'terminationDeadline',
    })) as bigint;

    const now = BigInt(Math.floor(Date.now() / 1000));
    if (deadline === 0n || now < deadline) {
      throw new BadRequestException(
        `Vault ${vaultAddress} claim window closes at ${deadline}; cannot sweep before then`
      );
    }

    return this._sendSimple(
      vaultId,
      vault,
      vaultAddress,
      TransactionType.evmSweepTerminationRemainder,
      'sweepTerminationRemainder',
      [asset],
      'TerminationRemainderSwept',
      null
    );
  }

  /**
   * Live termination state, read straight from the contract.
   *
   * Everything here is derived on-chain rather than from
   * `termination_metadata`, so it stays correct even if an event was missed.
   * The deadline is the field that matters most to a holder: after it they
   * permanently cannot redeem, and whatever they did not claim is swept to the
   * treasury. Surface it prominently.
   */
  async getEvmTerminationState(
    vaultId: string,
    holder?: Address
  ): Promise<{
    status: number;
    vtSupply: string;
    outstandingVt: string;
    committedAt: string;
    deadline: string;
    claimWindowOpen: boolean;
    secondsRemaining: string;
    assets: Array<{
      asset: Address;
      deferred: boolean;
      rate: string;
      cap: string;
      reserve: string;
      paid: string;
      released: string;
      deferredOutstanding: string;
      /** What `holder` would receive right now, if a holder was supplied. */
      preview?: string;
      /** Already-recorded deferred entitlement for `holder`. */
      deferredOwed?: string;
    }>;
    waived: Address[];
  }> {
    const cacheKey = `${vaultId}|${holder?.toLowerCase() ?? ''}`;
    const cached = this.stateCache.get(cacheKey);
    if (cached && Date.now() - cached.at < EvmTerminationService.STATE_CACHE_TTL_MS) {
      return cached.value as Awaited<ReturnType<EvmTerminationService['getEvmTerminationState']>>;
    }

    const vault = await this._requireEvmVault(vaultId);
    const vaultAddress = vault.contract_address as Address;
    const client = this.contractReader.publicClient;

    const read = <T>(functionName: string, args: unknown[] = []): Promise<T> =>
      client.readContract({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: functionName as any,
        args: args as any,
      }) as Promise<T>;

    const [status, vtSupply, outstanding, committedAt, deadline, assets, waived] = await Promise.all([
      read<number>('status'),
      read<bigint>('terminationSupply'),
      read<bigint>('terminationOutstanding'),
      read<bigint>('terminationCommittedAt'),
      read<bigint>('terminationDeadline'),
      read<Address[]>('terminationAssets'),
      read<Address[]>('waivedAssets'),
    ]);

    const now = BigInt(Math.floor(Date.now() / 1000));
    const claimWindowOpen = deadline > 0n && now < deadline;

    // One batch of reads per asset, all assets in parallel — up to
    // MAX_TERMINATION_ASSETS (16) so the fan-out is bounded.
    const rows = await Promise.all(
      assets.map(async asset => {
        const [info, preview, deferredOwed] = await Promise.all([
          read<readonly [boolean, boolean, bigint, bigint, bigint, bigint, bigint, bigint]>('terminationAsset', [
            asset,
          ]),
          holder ? read<bigint>('previewRedeem', [holder, asset]) : Promise.resolve<bigint | null>(null),
          holder ? read<bigint>('deferredOwed', [holder, asset]) : Promise.resolve<bigint | null>(null),
        ]);
        const [, deferred, rate, cap, reserve, paid, released, deferredOutstanding] = info as unknown as [
          boolean,
          boolean,
          bigint,
          bigint,
          bigint,
          bigint,
          bigint,
          bigint,
        ];

        const row: any = {
          asset,
          deferred,
          rate: rate.toString(),
          cap: cap.toString(),
          reserve: reserve.toString(),
          paid: paid.toString(),
          released: released.toString(),
          deferredOutstanding: deferredOutstanding.toString(),
        };
        if (holder) {
          row.preview = (preview ?? 0n).toString();
          row.deferredOwed = (deferredOwed ?? 0n).toString();
        }
        return row;
      })
    );

    const result = {
      status,
      vtSupply: vtSupply.toString(),
      outstandingVt: outstanding.toString(),
      committedAt: committedAt.toString(),
      deadline: deadline.toString(),
      claimWindowOpen,
      secondsRemaining: claimWindowOpen ? (deadline - now).toString() : '0',
      assets: rows,
      waived,
    };

    this.stateCache.set(cacheKey, { at: Date.now(), value: result });
    return result;
  }

  /**
   * Guard the operator escape hatches: `redeemFor`, `deferTerminationAsset` and
   * `resumeTerminationAsset` are only meaningful while the vault is on-chain
   * `Terminating`. The contract reverts otherwise anyway; this turns that into a
   * clean 400 instead of a burned admin transaction.
   */
  private async _requireTerminating(vaultAddress: Address): Promise<void> {
    const onchainStatus = (await this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'status',
    })) as number;
    if (onchainStatus !== EvmVaultOnchainStatus.Terminating) {
      throw new BadRequestException(
        `Vault ${vaultAddress} is ${EvmVaultOnchainStatus[onchainStatus] ?? onchainStatus}; ` +
          `termination asset operations require it to be Terminating`
      );
    }
  }

  private _sweepDelaySeconds(): bigint {
    const days = BigInt(this.systemSettings.evmTerminationSweepDelayDays);
    const seconds = days * 24n * 60n * 60n;
    // The contract enforces the same floor; clamp so a misconfigured setting
    // produces a working commit rather than a revert.
    return seconds < MIN_SWEEP_DELAY_SECONDS ? MIN_SWEEP_DELAY_SECONDS : seconds;
  }

  /**
   * Opaque commitment to the dataset behind the rates. Keys are emitted in a
   * fixed order so the hash is stable across engines, matching the approach
   * `EvmAllocationService` uses for cycle valuations.
   */
  private _valuationHash(
    vaultAddress: Address,
    totalSupply: bigint,
    rows: TerminationRateRow[],
    waived: Address[],
    sweepDelay: bigint
  ): Hex {
    const payload = JSON.stringify({
      assets: rows
        .map(r => ({
          asset: r.asset.toLowerCase(),
          free: r.free.toString(),
          implied: r.implied.toString(),
          rate: r.rate.toString(),
        }))
        .sort((a, b) => (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0)),
      schemaVersion: 1,
      sweepDelay: sweepDelay.toString(),
      totalSupply: totalSupply.toString(),
      vault: vaultAddress.toLowerCase(),
      waived: [...waived].map(w => w.toLowerCase()).sort(),
    });
    return keccak256(toBytes(payload)) as Hex;
  }

  /**
   * Phase 4 step 3 (final): call after all VT is burned (outstandingVt == 0).
   * Transitions on-chain → Terminated. DB vault → burned, and every asset row
   * still LOCKED is reconciled in the SAME transaction as the status flip, so a
   * crash cannot leave `vault=burned` with orphaned `locked` assets.
   */
  async finalizeTermination(vaultId: string): Promise<{ txHash: Hex }> {
    const vault = await this._requireEvmVault(vaultId);
    const waived = vault.termination_metadata?.evm?.waived ?? [];

    return this._sendSimple(
      vaultId,
      vault,
      vault.contract_address as Address,
      TransactionType.evmFinalizeTermination,
      'finalizeTermination',
      [],
      'VaultStatusChanged',
      VaultStatus.burned,
      manager => this._reconcileTerminatedAssets(manager, vaultId, waived)
    );
  }

  /**
   * DB-only reconciliation for a vault that is already `Terminated` on-chain but
   * whose backend row never caught up — e.g. the process died between the
   * on-chain confirm and the DB commit inside {@link finalizeTermination}, where
   * re-calling `finalizeTermination` just reverts (already Terminated) and never
   * self-heals. Idempotent; safe to call every lifecycle tick.
   */
  async reconcileFinalized(vaultId: string): Promise<void> {
    const vault = await this._requireEvmVault(vaultId);
    if (vault.vault_status === VaultStatus.burned) return;
    const waived = vault.termination_metadata?.evm?.waived ?? [];

    await this.dataSource.transaction(async manager => {
      await manager.update(Vault, { id: vaultId }, { vault_status: VaultStatus.burned });
      await this._reconcileTerminatedAssets(manager, vaultId, waived);
    });
    this.logger.log(`reconcileFinalized: vault=${vaultId} was Terminated on-chain; DB reconciled to burned`);
  }

  /**
   * Move every asset row still LOCKED into a terminal state, in the caller's
   * transaction:
   *   - waived assets → EXTRACTED  (they were routed to the treasury)
   *   - everything else → DISTRIBUTED  (paid to VT holders via redeem())
   * `policy_id` on an EVM asset row holds the token address (`0x…`, native uses
   * the zero address).
   */
  private async _reconcileTerminatedAssets(manager: EntityManager, vaultId: string, waived: string[]): Promise<void> {
    const waivedLower = [...new Set(waived.map(a => a.toLowerCase()))];
    const now = new Date();

    if (waivedLower.length > 0) {
      const ext = await manager
        .createQueryBuilder()
        .update(Asset)
        .set({ status: AssetStatus.EXTRACTED, released_at: now })
        .where('vault_id = :vaultId', { vaultId })
        .andWhere('status = :locked', { locked: AssetStatus.LOCKED })
        .andWhere('deleted = false')
        .andWhere('LOWER(policy_id) IN (:...waivedLower)', { waivedLower })
        .execute();
      if (ext.affected) {
        this.logger.log(`finalizeTermination: marked ${ext.affected} waived asset(s) EXTRACTED for vault=${vaultId}`);
      }
    }

    const dist = await manager.update(
      Asset,
      { vault_id: vaultId, status: AssetStatus.LOCKED, deleted: false },
      { status: AssetStatus.DISTRIBUTED, released_at: now }
    );
    if (dist.affected) {
      this.logger.log(`finalizeTermination: marked ${dist.affected} asset(s) DISTRIBUTED for vault=${vaultId}`);
    }
  }

  // ---------------------------------------------------------------------------

  private async _sendSimple(
    vaultId: string,
    vault: Vault,
    vaultAddress: Address,
    txType: TransactionType,
    fnName: string,
    args: unknown[],
    expectedEvent: string,
    nextVaultStatus: VaultStatus | null,
    /**
     * Extra DB work to run atomically with the post-confirm status flip — same
     * transaction, so it commits together or not at all. Only invoked when
     * `nextVaultStatus` is set.
     */
    afterConfirm?: (manager: EntityManager) => Promise<void>
  ): Promise<{ txHash: Hex }> {
    const adminTx = this.transactionsRepository.create({
      type: txType,
      status: TransactionStatus.pending,
      vault_id: vaultId,
      chain_id: vault.chain_id,
      from_address: this.adminSigner.address,
      to_address: vaultAddress,
      reconciliation_status: EvmReconciliationStatus.pending,
      reconciliation_attempts: 0,
      expected_events: [{ name: expectedEvent, count: 1 }],
    });
    await this.transactionsRepository.save(adminTx);

    let result: Awaited<ReturnType<EvmAdminSigner['sendAndConfirm']>>;
    try {
      result = await this.adminSigner.sendAndConfirm(
        { address: vaultAddress, abi: VAULT_ABI, functionName: fnName as any, args: args as any },
        [expectedEvent],
        async hash => {
          await this.transactionsRepository.update(
            { id: adminTx.id },
            { tx_hash: hash, status: TransactionStatus.submitted }
          );
        }
      );
    } catch (err) {
      await this._handleBroadcastError(adminTx.id, err, fnName);
      throw err;
    }

    if (nextVaultStatus) {
      await this.dataSource.transaction(async manager => {
        await manager.update(
          Transaction,
          { id: adminTx.id },
          {
            status: TransactionStatus.confirmed,
            reconciliation_status: EvmReconciliationStatus.success,
            reconciled_at: new Date(),
            reconciliation_last_error: null,
          }
        );
        await manager.update(Vault, { id: vaultId }, { vault_status: nextVaultStatus });
        if (afterConfirm) await afterConfirm(manager);
      });
    } else {
      await this.transactionsRepository.update(
        { id: adminTx.id },
        {
          status: TransactionStatus.confirmed,
          reconciliation_status: EvmReconciliationStatus.success,
          reconciled_at: new Date(),
          reconciliation_last_error: null,
        }
      );
    }

    this.logger.log(`${fnName} confirmed vault=${vaultId} tx=${result.hash}`);
    return { txHash: result.hash };
  }

  private async _requireEvmVault(vaultId: string): Promise<Vault> {
    const vault = await this.vaultsRepository.findOne({ where: { id: vaultId } });
    if (!vault) throw new NotFoundException(`Vault ${vaultId} not found`);
    if (vault.chain_type !== ChainType.robinhood) {
      throw new BadRequestException(`Vault ${vaultId} is not an EVM vault`);
    }
    if (!vault.contract_address) {
      throw new BadRequestException(`Vault ${vaultId} has no contract address`);
    }
    return vault;
  }

  private async _handleBroadcastError(adminTxId: string, err: unknown, fn: string): Promise<void> {
    if (err instanceof TxRevertedError) {
      await this.transactionsRepository.update(
        { id: adminTxId },
        {
          status: TransactionStatus.failed,
          tx_hash: err.hash,
          reconciliation_status: EvmReconciliationStatus.failed,
          reconciliation_last_error: `${fn} reverted: ${err.message.slice(0, 500)}`,
        }
      );
    } else {
      await this.transactionsRepository.update(
        { id: adminTxId },
        { reconciliation_last_error: `broadcast/receipt: ${(err as Error).message?.slice(0, 500)}` }
      );
    }
  }
}
