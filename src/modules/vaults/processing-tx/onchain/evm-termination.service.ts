import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
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

import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { SystemSettingsService } from '@/modules/globals/system-settings/system-settings.service';
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

    const rows = [];
    for (const asset of assets) {
      const info = (await read<readonly [boolean, boolean, bigint, bigint, bigint, bigint, bigint, bigint]>(
        'terminationAsset',
        [asset]
      )) as unknown as [boolean, boolean, bigint, bigint, bigint, bigint, bigint, bigint];
      const [, deferred, rate, cap, reserve, paid, released, deferredOutstanding] = info;

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
        row.preview = (await read<bigint>('previewRedeem', [holder, asset])).toString();
        row.deferredOwed = (await read<bigint>('deferredOwed', [holder, asset])).toString();
      }
      rows.push(row);
    }

    return {
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
   * Transitions on-chain → Terminated. DB vault → terminated.
   */
  async finalizeTermination(vaultId: string): Promise<{ txHash: Hex }> {
    const result = await this._sendSimple(
      vaultId,
      await this._requireEvmVault(vaultId),
      (await this._requireEvmVault(vaultId)).contract_address as Address,
      TransactionType.evmFinalizeTermination,
      'finalizeTermination',
      [],
      'VaultStatusChanged',
      VaultStatus.burned
    );

    return result;
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
    nextVaultStatus: VaultStatus | null
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
