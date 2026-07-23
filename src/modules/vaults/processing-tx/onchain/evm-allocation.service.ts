import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { keccak256, toBytes, type Address, type Hex } from 'viem';

import { buildAllocationMerkleTree, type AllocationLeafInput } from './evm-allocation-merkle';
import { computeEvmAllocationRows, type EvmAllocationInputRow } from './evm-allocation.formulas';
import { EvmContractReader } from './evm-contract-reader.service';
import type { ContributionValueMap } from './evm-lock-time-pricing.service';
import { EvmAssetKindOnchain } from './vault.abi';

import { EvmAllocation } from '@/database/evm-allocation.entity';
import { EvmContributionValuation } from '@/database/evm-contribution-valuation.entity';
import { EvmContribution, EvmContributionRowStatus } from '@/database/evm-contribution.entity';
import { EvmSnapshotStatus, EvmValuationSnapshot } from '@/database/evm-valuation-snapshot.entity';
import { Vault } from '@/database/vault.entity';
import { ChainType } from '@/types/vault.types';

export type { ContributionValueMap } from './evm-lock-time-pricing.service';

export interface ComputeSnapshotParams {
  vaultId: string;
  cycleId: bigint;
  /**
   * Per-contribution native values. See ContributionValueMap. Native
   * contributions are auto-priced; the map must cover EVERY non-Native
   * contribution — a missing entry is a hard error.
   */
  contributionValues: ContributionValueMap;
  /** Source string recorded on the snapshot's `price_source`, keyed by asset. */
  priceSource: Record<string, string>;
  /** Raw price payload snapshot (opaque; audit-only). */
  rawPrices?: Record<string, unknown>;
  /** Normalized wei-per-unit prices (audit-only). */
  normalizedPrices?: Record<string, string>;
  /** Optional bumping — defaults to 1. */
  schemaVersion?: number;
}

/**
 * Phase B — compute + persist EVM allocation snapshot for a vault+cycle.
 *
 * This is the read+write side that runs BEFORE any on-chain broadcast:
 *   1. Load vault + confirmed EvmContribution rows (status=active).
 *   2. Resolve per-contribution native value using the caller-provided map.
 *   3. Aggregate per-wallet and apply the allocation formulas.
 *   4. Build Merkle tree (SimpleMerkleTree, matches Solidity's leaf format).
 *   5. Persist snapshot + per-contribution valuations + allocations + proofs
 *      atomically inside a single DB transaction with status='calculated'.
 *   6. Return the snapshot ID.
 *
 * Callers then invoke `markReady(snapshotId)` before `EvmCycleCloseService`
 * broadcasts closeCycle. Once status advances to `ready` / `submitted` /
 * `confirmed`, the snapshot is IMMUTABLE — recomputing raises an error.
 */
@Injectable()
export class EvmAllocationService {
  private readonly logger = new Logger(EvmAllocationService.name);

  constructor(
    @InjectRepository(Vault) private readonly vaultsRepository: Repository<Vault>,
    @InjectRepository(EvmContribution) private readonly contribsRepository: Repository<EvmContribution>,
    @InjectRepository(EvmValuationSnapshot) private readonly snapshotsRepository: Repository<EvmValuationSnapshot>,
    @InjectRepository(EvmContributionValuation)
    private readonly valuationsRepository: Repository<EvmContributionValuation>,
    @InjectRepository(EvmAllocation) private readonly allocationsRepository: Repository<EvmAllocation>,
    private readonly dataSource: DataSource,
    private readonly contractReader: EvmContractReader
  ) {}

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  async computeSnapshot(params: ComputeSnapshotParams): Promise<{ snapshotId: string; leafCount: number }> {
    const {
      vaultId,
      cycleId,
      contributionValues,
      priceSource,
      rawPrices = {},
      normalizedPrices = {},
      schemaVersion = 1,
    } = params;

    const vault = await this.vaultsRepository.findOne({ where: { id: vaultId } });
    if (!vault) throw new NotFoundException(`Vault ${vaultId} not found`);
    if (vault.chain_type !== ChainType.robinhood) {
      throw new BadRequestException(`Vault ${vaultId} is not an EVM vault (chain_type=${vault.chain_type})`);
    }
    if (!vault.contract_address) {
      throw new BadRequestException(`Vault ${vaultId} has no on-chain address`);
    }
    if (
      !vault.ft_token_supply ||
      vault.ft_token_decimals === undefined ||
      vault.ft_token_decimals === null ||
      vault.tokens_for_acquires === undefined ||
      vault.tokens_for_acquires === null
    ) {
      throw new BadRequestException(
        `Vault ${vaultId} is missing supply/decimals/tokensForAcquires — cannot compute allocation`
      );
    }

    // Prevent overwriting a snapshot that has already been made ready or
    // committed on-chain.
    const existing = await this.snapshotsRepository.findOne({
      where: { vault_id: vaultId, cycle_id: cycleId.toString() },
    });
    if (existing && existing.status !== EvmSnapshotStatus.calculated) {
      throw new BadRequestException(
        `Snapshot for vault ${vaultId} cycle ${cycleId} is in status '${existing.status}' — cannot recompute`
      );
    }

    // Load active contributions for this vault + cycle. Only Solidity-Active
    // contributions feed the allocation (refunded / cancelled ones are OUT).
    const contributions = await this.contribsRepository.find({
      where: {
        vault_id: vaultId,
        cycle_id: cycleId.toString(),
        status: EvmContributionRowStatus.active,
      },
      order: { on_chain_contribution_id: 'ASC' },
    });

    if (contributions.length === 0) {
      throw new BadRequestException(
        `Vault ${vaultId} cycle ${cycleId} has no active contributions — nothing to allocate`
      );
    }

    // Build formula inputs.
    const formulaRows: EvmAllocationInputRow[] = [];
    const valuationRowsData: Array<{
      contribution: EvmContribution;
      valueNative: bigint;
      unitPriceNative: string;
    }> = [];

    for (const c of contributions) {
      const valueEntry = contributionValues.get(c.id);
      const contributionAmount = BigInt(c.amount);

      let valueNative: bigint;
      let unitPriceNative: string;

      if (c.kind === EvmAssetKindOnchain.Native) {
        // Native is self-priced 1 wei = 1 wei; validate caller agrees.
        valueNative = contributionAmount;
        unitPriceNative = '1';
        if (valueEntry && BigInt(valueEntry.valueNative) !== contributionAmount) {
          throw new BadRequestException(
            `Native contribution ${c.id} value mismatch: caller says ${valueEntry.valueNative}, on-chain says ${c.amount}`
          );
        }
      } else {
        if (!valueEntry) {
          throw new BadRequestException(
            `Missing price entry for non-Native contribution ${c.id} (kind=${c.kind}, asset=${c.asset})`
          );
        }
        valueNative = BigInt(valueEntry.valueNative);
        unitPriceNative = valueEntry.unitPriceNative;
      }

      formulaRows.push({
        contributor: c.contributor.toLowerCase() as `0x${string}`,
        nativeRaised: c.kind === EvmAssetKindOnchain.Native ? contributionAmount : 0n,
        contributedValue: c.kind === EvmAssetKindOnchain.Native ? 0n : valueNative,
      });

      valuationRowsData.push({ contribution: c, valueNative, unitPriceNative });
    }

    // Run the formulas.
    const vtSupplyBaseUnits = BigInt(vault.ft_token_supply) * 10n ** BigInt(vault.ft_token_decimals);
    const assetsOfferedBps = Math.round(Number(vault.tokens_for_acquires) * 100); // percent → bips
    const formulaResult = computeEvmAllocationRows({
      rows: formulaRows,
      vtSupplyBaseUnits,
      assetsOfferedBps,
      // LP carveout deferred — see plan Phase B open items.
      lpVtAmount: 0n,
      lpNativeAmount: 0n,
    });

    if (formulaResult.perWallet.length === 0) {
      throw new BadRequestException('Allocation formula produced zero-length wallet result');
    }

    // Build Merkle leaves.
    const leafInputs: AllocationLeafInput[] = formulaResult.perWallet.map((r, index) => ({
      vault: vault.contract_address as Address,
      chainId: BigInt(vault.chain_id ?? 0),
      cycleId,
      claimIndex: BigInt(index),
      contributor: r.contributor,
      vtAmount: r.vtAmount,
      nativeAmount: r.nativeAmount,
    }));
    const tree = buildAllocationMerkleTree(leafInputs);

    // Compute valuation hash = keccak256(canonicalJson(snapshot payload)).
    const canonicalPayload = this.buildCanonicalPayload({
      vaultId,
      cycleId,
      leafInputs,
      totalVtAllocation: formulaResult.totalVtAllocation,
      totalNativeAllocation: formulaResult.totalNativeAllocation,
      merkleRoot: tree.root,
      priceSource,
      normalizedPrices,
      schemaVersion,
    });
    const valuationHash = keccak256(toBytes(canonicalPayload)) as Hex;

    // Persist snapshot + child rows atomically.
    const snapshotId = await this.dataSource.transaction(async manager => {
      // Delete any prior 'calculated' snapshot for this pair (recompute case).
      if (existing) {
        await manager.delete(EvmValuationSnapshot, { id: existing.id });
      }

      const snapshot = manager.create(EvmValuationSnapshot, {
        vault_id: vaultId,
        cycle_id: cycleId.toString(),
        schema_version: schemaVersion,
        price_source: priceSource,
        price_timestamp: new Date(),
        raw_prices: rawPrices,
        normalized_prices: normalizedPrices,
        total_native_raised: formulaResult.totalNativeRaised.toString(),
        total_asset_value_native: formulaResult.totalContributedValue.toString(),
        fdv_native: (formulaResult.totalContributedValue + formulaResult.totalNativeRaised).toString(),
        vt_price: '0',
        lp_carveout: {},
        merkle_root: tree.root,
        valuation_hash: valuationHash,
        total_vt_allocation: formulaResult.totalVtAllocation.toString(),
        total_native_allocation: formulaResult.totalNativeAllocation.toString(),
        status: EvmSnapshotStatus.calculated,
      });
      const savedSnapshot = await manager.save(snapshot);

      // Per-contribution valuations.
      const valuationEntities = valuationRowsData.map(v => {
        const unitPriceBig = BigInt(v.unitPriceNative);
        // amount_normalized is 18-decimal-scaled base value:
        //   value_wei = amount_normalized * unit_price_wei / 10^18
        // so amount_normalized = value_wei * 10^18 / unit_price_wei.
        // (Reverses cleanly because our formula stores unit prices as bigint
        // wei per whole unit — see EvmLockTimePricingService.)
        const amountNormalized = unitPriceBig > 0n ? (v.valueNative * 10n ** 18n) / unitPriceBig : 0n;
        return manager.create(EvmContributionValuation, {
          snapshot_id: savedSnapshot.id,
          evm_contribution_id: v.contribution.id,
          on_chain_contribution_id: v.contribution.on_chain_contribution_id,
          contributor: v.contribution.contributor.toLowerCase(),
          kind: v.contribution.kind,
          asset: v.contribution.asset.toLowerCase(),
          token_id: v.contribution.token_id,
          amount_raw: v.contribution.amount,
          amount_normalized: amountNormalized.toString(),
          unit_price_native: v.unitPriceNative,
          value_native: v.valueNative.toString(),
        });
      });
      await manager.save(EvmContributionValuation, valuationEntities);

      // Allocation leaves + proofs.
      const allocationEntities = leafInputs.map((leaf, i) =>
        manager.create(EvmAllocation, {
          snapshot_id: savedSnapshot.id,
          vault_id: vaultId,
          cycle_id: cycleId.toString(),
          claim_index: leaf.claimIndex.toString(),
          contributor: leaf.contributor.toLowerCase(),
          vt_amount: leaf.vtAmount.toString(),
          native_amount: leaf.nativeAmount.toString(),
          proof: tree.proofs[i],
        })
      );
      await manager.save(EvmAllocation, allocationEntities);

      return savedSnapshot.id;
    });

    this.logger.log(
      `Computed snapshot ${snapshotId} for vault ${vaultId} cycle ${cycleId}: ` +
        `${leafInputs.length} leaves, root=${tree.root}, ` +
        `totalVt=${formulaResult.totalVtAllocation}, totalNative=${formulaResult.totalNativeAllocation}`
    );
    return { snapshotId, leafCount: leafInputs.length };
  }

  /**
   * Advance a snapshot from `calculated` → `ready`. Runs the pre-broadcast
   * sanity checks:
   *
   *   - Merkle root non-zero, valuation hash present.
   *   - On-chain `cycle.nativeCollected >= cycle.minAcquireThreshold` (this is
   *     the ONLY threshold check — the compare is threshold vs collected, not
   *     against our totalNativeAllocation).
   *   - The prepared totalNativeAllocation is `<= cycle.nativeCollected`
   *     (we cannot claim to pay out more native than the vault holds).
   *
   * Zero totalVtAllocation and/or zero totalNativeAllocation are allowed —
   * some vault configurations legitimately produce those (e.g. 100% acquire
   * with no native raised, or 0% acquire and only NFT contributions).
   */
  async markReady(snapshotId: string): Promise<void> {
    const snapshot = await this.snapshotsRepository.findOne({ where: { id: snapshotId } });
    if (!snapshot) throw new NotFoundException(`Snapshot ${snapshotId} not found`);

    if (snapshot.status !== EvmSnapshotStatus.calculated) {
      throw new BadRequestException(
        `Snapshot ${snapshotId} is in status '${snapshot.status}'; expected 'calculated' to advance to 'ready'`
      );
    }
    if (!snapshot.merkle_root || snapshot.merkle_root === '0x' + '00'.repeat(32)) {
      throw new BadRequestException(`Snapshot ${snapshotId} has zero/missing Merkle root`);
    }
    if (!snapshot.valuation_hash) {
      throw new BadRequestException(`Snapshot ${snapshotId} has missing valuation hash`);
    }

    const vault = await this.vaultsRepository.findOne({ where: { id: snapshot.vault_id } });
    if (!vault?.contract_address) {
      throw new BadRequestException(`Vault ${snapshot.vault_id} has no contract address`);
    }
    const cycleView = await this.contractReader.getCycle(vault.contract_address as Address, BigInt(snapshot.cycle_id));

    // Threshold gate: on-chain nativeCollected must meet the configured min.
    if (cycleView.nativeCollected < cycleView.minAcquireThreshold) {
      throw new BadRequestException(
        `Cycle ${snapshot.cycle_id} nativeCollected ${cycleView.nativeCollected} is below ` +
          `minAcquireThreshold ${cycleView.minAcquireThreshold} — cannot advance to 'ready'. ` +
          `Route this vault to cancelCurrentCycle() instead.`
      );
    }

    // Solvency: totalNativeAllocation cannot exceed native held by the vault.
    // This is NOT the threshold check — it's a solvency invariant that would
    // cause closeCycle to revert on `CycleCloseNativeShortfall` otherwise.
    const totalNativeAllocation = BigInt(snapshot.total_native_allocation);
    if (totalNativeAllocation > cycleView.nativeCollected) {
      throw new BadRequestException(
        `Snapshot ${snapshotId} totalNativeAllocation ${totalNativeAllocation} exceeds ` +
          `on-chain nativeCollected ${cycleView.nativeCollected} — refusing to advance to 'ready'`
      );
    }

    await this.snapshotsRepository.update({ id: snapshotId }, { status: EvmSnapshotStatus.ready });
    this.logger.log(`Snapshot ${snapshotId} → ready`);
  }

  /** Fetch the current (calculated / ready / submitted / confirmed) snapshot for a vault+cycle. */
  async getSnapshot(vaultId: string, cycleId: bigint): Promise<EvmValuationSnapshot | null> {
    return this.snapshotsRepository.findOne({ where: { vault_id: vaultId, cycle_id: cycleId.toString() } });
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /**
   * Canonical JSON encoding — deterministic key order + bigint-as-string —
   * used as the preimage for `valuation_hash` (bytes32 committed on-chain).
   */
  private buildCanonicalPayload(input: {
    vaultId: string;
    cycleId: bigint;
    leafInputs: AllocationLeafInput[];
    totalVtAllocation: bigint;
    totalNativeAllocation: bigint;
    merkleRoot: Hex;
    priceSource: Record<string, string>;
    normalizedPrices: Record<string, string>;
    schemaVersion: number;
  }): string {
    // Sort keys alphabetically at every level to keep the hash stable across
    // JavaScript engine versions and locales.
    return JSON.stringify({
      cycleId: input.cycleId.toString(),
      leaves: input.leafInputs.map(l => ({
        chainId: l.chainId.toString(),
        claimIndex: l.claimIndex.toString(),
        contributor: l.contributor.toLowerCase(),
        cycleId: l.cycleId.toString(),
        nativeAmount: l.nativeAmount.toString(),
        vault: l.vault.toLowerCase(),
        vtAmount: l.vtAmount.toString(),
      })),
      merkleRoot: input.merkleRoot,
      normalizedPrices: sortedObject(input.normalizedPrices),
      priceSource: sortedObject(input.priceSource),
      schemaVersion: input.schemaVersion,
      totalNativeAllocation: input.totalNativeAllocation.toString(),
      totalVtAllocation: input.totalVtAllocation.toString(),
      vaultId: input.vaultId,
    });
  }
}

function sortedObject<T>(obj: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
}
