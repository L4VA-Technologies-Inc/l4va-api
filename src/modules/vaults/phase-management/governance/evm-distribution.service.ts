import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { Repository } from 'typeorm';
import { encodeAbiParameters, keccak256, parseAbi, zeroAddress, zeroHash, type Address, type Hex } from 'viem';

import { EvmAdminSigner } from '../../processing-tx/onchain/evm-admin-signer.service';
import { EvmContractReader } from '../../processing-tx/onchain/evm-contract-reader.service';
import { getEvmProtocolVersion } from '../../processing-tx/onchain/evm-protocol-versions';
import { vaultIsV13, VAULT_V13_ABI } from '../../processing-tx/onchain/evm-v13';
import { VAULT_ABI } from '../../processing-tx/onchain/vault.abi';

import type { EvmDistributionPayout } from './dto/distribution.dto';
import { buildDistributionTree, type DistributionTree } from './evm-distribution-merkle';
import { EvmSnapshotService } from './evm-snapshot.service';
import { ProposalConditionsChangedError } from './proposal-errors';
import { countSnapshotRecipients } from './snapshot-recipients.util';
import { votingBalances } from './voting-power.util';

import { Proposal } from '@/database/proposal.entity';
import { Snapshot } from '@/database/snapshot.entity';
import { Vault } from '@/database/vault.entity';
import { REDIS_CLIENT } from '@/modules/redis/redis.module';
import { ProposalStatus, ProposalType } from '@/types/proposal.types';
import { ChainType } from '@/types/vault.types';

/** Matches `MIN_DISTRIBUTION_CLAIM_WINDOW` in Vault.sol. */
export const MIN_CLAIM_WINDOW_SECONDS = 90 * 24 * 60 * 60;

/** Default claim window. Generous on purpose: unclaimed funds go to treasury. */
export const DEFAULT_CLAIM_WINDOW_SECONDS = 180 * 24 * 60 * 60;

/** Most `claimDistributionFor` transactions sent per cron tick, across all distributions. */
const AUTO_CLAIM_MAX_PER_TICK = 50;
/** After this many failed auto-claims a holder is skipped, so one bad recipient cannot keep a pot open. */
const AUTO_CLAIM_MAX_FAILURES_PER_HOLDER = 5;
/** Shared across API replicas: only one worker sends claims at a time (one admin key, one nonce). */
const AUTO_CLAIM_LOCK_KEY = 'evm:distribution:auto-claim:lock';
const AUTO_CLAIM_LOCK_TTL_SECONDS = 300;
const SWEEP_LOCK_KEY = 'evm:distribution:sweep:lock';
const SWEEP_LOCK_TTL_SECONDS = 600;
/** Mirrors `Vault.sol#MAX_ACTIVE_DISTRIBUTIONS` (V13): a slot is freed by a cancel or a sweep. */
export const MAX_ACTIVE_DISTRIBUTIONS = 8;

export interface EvmDistributionValidation {
  valid: boolean;
  reason?: string;
  asset: string;
  requestedAmount: string;
  availableAmount: string;
  holderCount: number;
  circulatingSupply: string;
  timepoint: string | null;
}

export interface EvmDistributionOpenResult {
  distributionId: string;
  txHash: string | null;
  asset: string;
  netPot: string;
  supply: string;
  timepoint: string;
  deadline: string;
  /** True when a prior attempt had already opened this distribution on-chain. */
  reconciled: boolean;
}

/**
 * EVM counterpart to the Cardano `DistributionService`.
 *
 * The two are deliberately NOT unified. Cardano pays from a per-vault treasury
 * wallet whose keys the backend holds, batching multi-recipient transactions.
 * EVM has no treasury wallet and should not grow one: the funds already sit in
 * the vault contract, and `openDistribution` reserves them there so holders can
 * claim trustlessly. The backend never takes custody.
 */
const LP_SOURCE_ABI = parseAbi([
  'function factory() view returns (address)',
  'function lpShareSource() view returns (address)',
]);
const LP_REGISTRY_ABI = parseAbi([
  'function record(address vault, uint256 timepoint, address[] accounts, uint256[] vts)',
  'function finalize(address vault, uint256 timepoint)',
  'function recorded(address vault, address account, uint256 timepoint) view returns (uint256 vt, uint256 total, bool finalized)',
  'event Recorded(address indexed vault, uint256 indexed timepoint, uint256 accounts, uint256 total)',
  'event Finalized(address indexed vault, uint256 indexed timepoint, uint256 total)',
]);
/** Accounts per `L4VALpShareRegistry.record` transaction. */
const LP_RECORD_BATCH = 200;

@Injectable()
export class EvmDistributionService {
  private readonly logger = new Logger(EvmDistributionService.name);

  constructor(
    @InjectRepository(Vault) private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Proposal) private readonly proposalRepository: Repository<Proposal>,
    @InjectRepository(Snapshot) private readonly snapshotRepository: Repository<Snapshot>,
    private readonly contractReader: EvmContractReader,
    private readonly adminSigner: EvmAdminSigner,
    private readonly evmSnapshotService: EvmSnapshotService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis
  ) {}

  /**
   * Deterministic per-proposal idempotency key.
   *
   * Stable across retries and unique per proposal, which is exactly what the
   * contract's `_distributionByExecutionKey` needs: if a submission lands but
   * the receipt or the database write is lost, the retry is rejected on-chain
   * instead of reserving and paying the pot a second time.
   */
  buildExecutionKey(vaultId: string, proposalId: string): Hex {
    return keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'string' }], [vaultId, proposalId]));
  }

  /**
   * Can this vault distribute `amount` of `asset` right now?
   *
   * Reads the vault contract's *available* balance, not its raw balance —
   * contributor refunds, accrued fees, the termination reserve and any other
   * open distribution are all already netted out on-chain, so this is the
   * figure `openDistribution` will actually check against.
   */
  async validateDistribution(vaultId: string, asset: string, amount: string): Promise<EvmDistributionValidation> {
    const vault = await this.requireEvmVault(vaultId);
    const vaultAddress = vault.contract_address as Address;
    const assetAddress = (asset || zeroAddress) as Address;

    const snapshot = await this.latestSnapshot(vaultId);
    const holderCount = await this.recipientCount(snapshot, vaultAddress);

    const base: EvmDistributionValidation = {
      valid: false,
      asset: assetAddress,
      requestedAmount: amount,
      availableAmount: '0',
      holderCount,
      circulatingSupply: '0',
      timepoint: snapshot?.snapshotTimepoint ?? null,
    };

    let requested: bigint;
    try {
      requested = BigInt(amount);
    } catch {
      return { ...base, reason: `Amount '${amount}' is not an integer in base units` };
    }
    if (requested <= 0n) return { ...base, reason: 'Distribution amount must be greater than 0' };

    const available = await this.availableForDistribution(vaultAddress, assetAddress);
    base.availableAmount = String(available);

    if (!snapshot) {
      return { ...base, reason: 'No snapshot available for this vault. Cannot determine holder shares.' };
    }
    if (!snapshot.snapshotTimepoint) {
      return {
        ...base,
        reason:
          'The latest snapshot predates chain-timepoint recording and cannot back a distribution. A new snapshot will be taken.',
      };
    }

    const supply = await this.circulatingSupplyAt(vaultAddress, BigInt(snapshot.snapshotTimepoint));
    base.circulatingSupply = String(supply);

    if (supply === 0n) {
      return { ...base, reason: 'No circulating VT at the snapshot timepoint. Nothing to distribute to.' };
    }
    if (requested > available) {
      return {
        ...base,
        reason: `Requested ${requested} exceeds the vault's available ${assetAddress === zeroAddress ? 'native' : 'token'} balance of ${available}`,
      };
    }

    // V13 holds at most MAX_ACTIVE_DISTRIBUTIONS open pots; one more reverts on execution. A slot
    // frees when a pot is cancelled or swept after its claim window. Passed proposals that have not
    // opened their pot yet take a slot too.
    if (vaultIsV13(vault)) {
      const active = Number(
        (await this.contractReader.publicClient.readContract({
          address: vaultAddress,
          abi: VAULT_V13_ABI,
          functionName: 'activeDistributions',
          args: [],
        })) as bigint
      );
      const queued = await this.proposalRepository
        .createQueryBuilder('p')
        .where('p.vault_id = :vaultId', { vaultId })
        .andWhere('p.proposal_type = :type', { type: ProposalType.DISTRIBUTION })
        .andWhere('p.status IN (:...statuses)', { statuses: [ProposalStatus.ACTIVE, ProposalStatus.PASSED] })
        .getCount();
      if (active + queued >= MAX_ACTIVE_DISTRIBUTIONS) {
        return {
          ...base,
          reason:
            `This vault already has ${active} open distribution(s) and ${queued} in voting or awaiting execution; ` +
            `at most ${MAX_ACTIVE_DISTRIBUTIONS} can be open at once. A slot frees when a distribution's claim window ends.`,
        };
      }
    }

    return { ...base, valid: true };
  }

  /**
   * Reserve the pot on-chain for a passed proposal.
   *
   * Reconciles against the execution key BEFORE submitting. A non-zero id means
   * a previous attempt already landed and only the bookkeeping was lost, so the
   * correct action is to backfill from chain rather than open a second pot.
   */
  async executeDistribution(proposal: Proposal): Promise<EvmDistributionOpenResult> {
    // Funds leave the vault here, so only a proposal that passed its vote may
    // reach the contract, whatever path called us.
    if (proposal.proposalType !== ProposalType.DISTRIBUTION || proposal.status !== ProposalStatus.PASSED) {
      throw new BadRequestException(
        `Proposal ${proposal.id} (${proposal.proposalType}, ${proposal.status}) is not a PASSED distribution proposal`
      );
    }

    const vault = await this.requireEvmVault(proposal.vaultId);
    const vaultAddress = vault.contract_address as Address;

    const asset = (proposal.metadata?.distributionAsset || zeroAddress) as Address;
    const amount = proposal.metadata?.distributionAmount;
    if (!amount) {
      throw new BadRequestException(`Proposal ${proposal.id} has no distributionAmount`);
    }

    const executionKey = this.buildExecutionKey(proposal.vaultId, proposal.id);

    // Reconcile first — the on-chain key is the authority on whether this
    // proposal has already been executed, not our database.
    const existingId = await this.readDistributionIdForKey(vaultAddress, executionKey);
    if (existingId > 0n) {
      this.logger.warn(
        `Proposal ${proposal.id}: execution key ${executionKey} already opened distribution ${existingId} on-chain. ` +
          `Backfilling from chain instead of opening a second distribution.`
      );
      const onchain = await this.readDistribution(vault, existingId);
      return {
        distributionId: String(existingId),
        txHash: null,
        asset: onchain.asset,
        netPot: String(onchain.netPot),
        supply: String(onchain.supply),
        timepoint: String(onchain.timepoint),
        deadline: String(onchain.deadline),
        reconciled: true,
      };
    }

    // Not opened yet: the vault must still hold the amount voted for. If it no longer does (other
    // proposals spent it), the proposal cannot run as voted and is rejected rather than retried.
    let requested: bigint;
    try {
      requested = BigInt(amount);
    } catch {
      throw new ProposalConditionsChangedError(
        `The distribution amount '${amount}' is not a whole number of base units.`
      );
    }
    const available = await this.availableForDistribution(vaultAddress, asset);
    if (requested > available) {
      throw new ProposalConditionsChangedError(
        `The vault no longer has enough ${asset === zeroAddress ? 'ETH' : 'tokens'} free for this distribution ` +
          `(needs ${requested}, ${available} available in base units).`
      );
    }

    const timepoint = await this.resolveTimepoint(proposal);

    // Vaults that support it pay by snapshot voting weight (held VT + VT in
    // liquidity positions), like Cardano; older vaults pay pro-rata on-chain.
    // V13 has no Merkle mode (it still answers `distributionMerkleRoot` with zero): it pays
    // pro-rata on-chain, with LP-held VT once the L4VA LP contract is switched on.
    let tree: DistributionTree | null = null;
    if (!vaultIsV13(vault) && (await this.supportsMerkleDistribution(vaultAddress))) {
      const snapshot = await this.snapshotForTimepoint(proposal, timepoint);
      if (!snapshot) throw new Error(`Proposal ${proposal.id}: no snapshot at timepoint ${timepoint} to weight from`);
      tree = this.buildTree(vaultAddress, executionKey, snapshot);
    }

    // V13 with LP payouts on: record LP providers' pool VT for this timepoint first, so the
    // distribution's supply and payouts include them (no action needed from them).
    if (vaultIsV13(vault)) await this.recordLpShares(proposal, vault, timepoint);

    const window = BigInt(DEFAULT_CLAIM_WINDOW_SECONDS);
    const result = await this.adminSigner.sendAndConfirm(
      tree
        ? {
            address: vaultAddress,
            abi: VAULT_ABI,
            functionName: 'openDistributionMerkle',
            args: [executionKey, asset, BigInt(amount), Number(timepoint), tree.root, tree.totalWeight, window],
          }
        : {
            address: vaultAddress,
            abi: VAULT_ABI,
            functionName: 'openDistribution',
            args: [executionKey, asset, BigInt(amount), Number(timepoint), window],
          },
      ['DistributionOpened']
    );

    const opened = result.decodedEvents.find(
      e => e.eventName === 'DistributionOpened' && e.address.toLowerCase() === vaultAddress.toLowerCase()
    );
    if (!opened) {
      // The transaction succeeded but the event we key everything off is
      // missing. Do not guess an id — the execution key makes a later
      // reconciliation safe, so fail loudly and let the retry resolve it.
      throw new Error(
        `openDistribution for proposal ${proposal.id} confirmed in ${result.hash} but emitted no DistributionOpened from ${vaultAddress}`
      );
    }

    const distributionId = String(opened.args.distributionId as bigint);
    this.logger.log(
      `Proposal ${proposal.id}: opened distribution ${distributionId} on ${vaultAddress} — ` +
        `asset=${asset} netPot=${opened.args.netPot} supply=${opened.args.supply} timepoint=${timepoint} ` +
        `${tree ? `merkleRoot=${tree.root} holders=${tree.entries.size} ` : ''}tx=${result.hash}`
    );

    return {
      distributionId,
      txHash: result.hash,
      asset,
      netPot: String(opened.args.netPot as bigint),
      supply: String(opened.args.supply as bigint),
      timepoint: String(timepoint),
      deadline: String(opened.args.deadline as bigint),
      reconciled: false,
    };
  }

  /** Pay one holder with the admin key covering gas. Funds go only to `holder`. */
  async claimFor(vaultId: string, distributionId: string, holder: Address): Promise<string> {
    const vault = await this.requireEvmVault(vaultId);
    const vaultAddress = vault.contract_address as Address;

    const alreadyClaimed = (await this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'isDistributionClaimed',
      args: [BigInt(distributionId), holder],
    })) as boolean;
    if (alreadyClaimed) {
      throw new BadRequestException(`${holder} has already claimed distribution ${distributionId}`);
    }

    const result = await this.adminSigner.sendAndConfirm(
      {
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: 'claimDistributionFor',
        args: [BigInt(distributionId), holder],
      },
      ['DistributionClaimed']
    );
    return result.hash;
  }

  /**
   * Pays every open EVM distribution out to its holders, admin covering gas —
   * the EVM counterpart of the Cardano batch payout, so holders never have to
   * claim. Holders come from the snapshot the pot was opened against; the
   * contract decides each share (`distributionClaimable`), returns 0 for
   * excluded holders (LP pools) and for anyone already paid, and rejects a
   * second claim, so re-running a tick is safe. A distribution is marked done
   * once a full pass finds nothing left to pay.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async autoClaimOpenDistributions(): Promise<void> {
    if (this.autoClaimRunning) return;
    if (['false', '0'].includes(process.env.EVM_DISTRIBUTION_AUTO_CLAIM ?? '')) return;
    const lockToken = `${process.pid}:${Date.now()}`;
    const locked = await this.redis
      .set(AUTO_CLAIM_LOCK_KEY, lockToken, 'EX', AUTO_CLAIM_LOCK_TTL_SECONDS, 'NX')
      .catch(() => null);
    if (locked !== 'OK') return;
    this.autoClaimRunning = true;
    try {
      const proposals = await this.proposalRepository
        .createQueryBuilder('p')
        .innerJoin(Vault, 'v', 'v.id = p.vault_id')
        .where('p.proposal_type = :type', { type: ProposalType.DISTRIBUTION })
        .andWhere('p.status = :status', { status: ProposalStatus.EXECUTED })
        .andWhere('v.chain_type = :chain', { chain: ChainType.robinhood })
        .andWhere("(p.metadata -> 'evmDistribution' ->> 'autoClaimCompletedAt') IS NULL")
        .getMany();

      let budget = AUTO_CLAIM_MAX_PER_TICK;
      for (const proposal of proposals) {
        if (budget <= 0) break;
        budget -= await this.autoClaimDistribution(proposal, budget);
      }
    } catch (err) {
      this.logger.error(`EVM distribution auto-claim sweep failed: ${(err as Error).message}`);
    } finally {
      this.autoClaimRunning = false;
      // Release only our own lock; an expired one may already belong to another worker.
      if ((await this.redis.get(AUTO_CLAIM_LOCK_KEY).catch(() => null)) === lockToken) {
        await this.redis.del(AUTO_CLAIM_LOCK_KEY).catch(() => undefined);
      }
    }
  }

  private autoClaimRunning = false;

  /**
   * Hourly: close every EVM distribution whose claim window has ended with `sweepDistributionRemainder`.
   * That frees its slot (`activeDistributions`, at most 8 on V13) and sends what nobody claimed to the
   * vault's treasury, as the contract defines. Auto-claim pays every snapshot holder first, so the
   * remainder is usually only shares nobody could be paid (failed claims, excluded holders, rounding).
   */
  @Cron(CronExpression.EVERY_HOUR)
  async sweepEndedDistributions(): Promise<void> {
    if (['false', '0'].includes(process.env.EVM_DISTRIBUTION_SWEEP ?? '')) return;
    const lockToken = `${process.pid}:${Date.now()}`;
    const locked = await this.redis
      .set(SWEEP_LOCK_KEY, lockToken, 'EX', SWEEP_LOCK_TTL_SECONDS, 'NX')
      .catch(() => null);
    if (locked !== 'OK') return;
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const proposals = await this.proposalRepository
        .createQueryBuilder('p')
        .innerJoin(Vault, 'v', 'v.id = p.vault_id')
        .where('p.proposal_type = :type', { type: ProposalType.DISTRIBUTION })
        .andWhere('p.status = :status', { status: ProposalStatus.EXECUTED })
        .andWhere('v.chain_type = :chain', { chain: ChainType.robinhood })
        .andWhere("(p.metadata -> 'evmDistribution' ->> 'distributionId') IS NOT NULL")
        .andWhere("(p.metadata -> 'evmDistribution' ->> 'sweptAt') IS NULL")
        .andWhere("(p.metadata -> 'evmDistribution' ->> 'deadline')::bigint <= :now", { now: nowSec })
        .getMany();
      for (const proposal of proposals) {
        await this.sweepDistribution(proposal).catch(err =>
          this.logger.error(`Distribution sweep for proposal ${proposal.id} failed: ${(err as Error).message}`)
        );
      }
    } catch (err) {
      this.logger.error(`EVM distribution sweep failed: ${(err as Error).message}`);
    } finally {
      if ((await this.redis.get(SWEEP_LOCK_KEY).catch(() => null)) === lockToken) {
        await this.redis.del(SWEEP_LOCK_KEY).catch(() => undefined);
      }
    }
  }

  private async sweepDistribution(proposal: Proposal): Promise<void> {
    const dist = proposal.metadata?.evmDistribution;
    if (!dist?.distributionId) return;
    const vault = await this.requireEvmVault(proposal.vaultId);
    const vaultAddress = vault.contract_address as Address;
    const id = BigInt(dist.distributionId);

    let txHash: string | null = null;
    try {
      const result = await this.adminSigner.sendAndConfirm(
        { address: vaultAddress, abi: VAULT_ABI, functionName: 'sweepDistributionRemainder', args: [id] },
        ['DistributionRemainderSwept'],
        async () => {}
      );
      txHash = result.hash;
    } catch (err) {
      // Swept earlier (e.g. the receipt or the DB write was lost): only the bookkeeping is missing.
      if (!/DistributionAlreadySwept/.test((err as Error).message)) throw err;
    }

    const fresh = await this.proposalRepository.findOne({ where: { id: proposal.id } });
    if (!fresh?.metadata?.evmDistribution) return;
    await this.proposalRepository.update(
      { id: proposal.id },
      {
        metadata: {
          ...fresh.metadata,
          evmDistribution: {
            ...fresh.metadata.evmDistribution,
            sweptAt: new Date().toISOString(),
            sweepTxHash: txHash,
          },
        },
      }
    );
    this.logger.log(
      `Distribution ${dist.distributionId} on ${vaultAddress} swept after its claim window` +
        (txHash ? ` tx=${txHash}` : ' (already swept on-chain)')
    );
  }

  /** Pays up to `budget` holders of one distribution; returns how many transactions it sent. */
  private async autoClaimDistribution(proposal: Proposal, budget: number): Promise<number> {
    const vault = await this.requireEvmVault(proposal.vaultId);
    const vaultAddress = vault.contract_address as Address;

    // The chain, not the proposal row, is the authority on what was opened: a
    // racing save of the proposal can drop `metadata.evmDistribution`.
    let dist = proposal.metadata?.evmDistribution;
    if (!dist?.distributionId) {
      const id = await this.readDistributionIdForKey(
        vaultAddress,
        this.buildExecutionKey(proposal.vaultId, proposal.id)
      );
      if (id === 0n) return 0; // not opened (yet)
      const onchain = await this.readDistribution(vault, id);
      dist = {
        distributionId: String(id),
        asset: onchain.asset,
        netPot: String(onchain.netPot),
        supply: String(onchain.supply),
        timepoint: String(onchain.timepoint),
        deadline: String(onchain.deadline),
        txHash: null,
        openedAt: new Date().toISOString(),
      };
      await this.proposalRepository.update(
        { id: proposal.id },
        { metadata: { ...proposal.metadata, evmDistribution: dist } }
      );
      proposal.metadata = { ...proposal.metadata, evmDistribution: dist };
      this.logger.warn(
        `Proposal ${proposal.id}: evmDistribution metadata was missing, restored distribution ${id} from chain`
      );
    }
    const distributionId = BigInt(dist.distributionId);

    // V13: a distribution is claimable after its delay (or the verifier's approval) and may be
    // cancelled before that. Claiming early would revert and count against the holder.
    if (vaultIsV13(vault)) {
      const v13 = (await this.contractReader.publicClient.readContract({
        address: vaultAddress,
        abi: VAULT_V13_ABI,
        functionName: 'getDistribution',
        args: [distributionId],
      })) as { activatesAt: bigint; cancelled: boolean; approved: boolean; deadline: bigint };
      if (v13.cancelled) {
        await this.markAutoClaimDone(proposal, 'distribution cancelled on-chain');
        return 0;
      }
      if (!v13.approved && Number(v13.activatesAt) * 1000 > Date.now()) return 0;
      if (String(v13.deadline) !== String(dist.deadline)) dist = { ...dist, deadline: String(v13.deadline) };
    }

    if (Number(dist.deadline) * 1000 <= Date.now()) {
      // Claims are closed on-chain; the remainder goes to the treasury by sweep.
      await this.markAutoClaimDone(proposal, 'claim window closed');
      return 0;
    }

    const snapshot =
      (await this.snapshotRepository.findOne({
        where: { vaultId: proposal.vaultId, snapshotTimepoint: dist.timepoint },
      })) ?? (await this.snapshotRepository.findOne({ where: { id: proposal.snapshotId } }));
    if (!snapshot) {
      this.logger.warn(`Distribution ${dist.distributionId} (proposal ${proposal.id}): no holder snapshot, skipping`);
      return 0;
    }

    const tree = await this.treeForDistribution(proposal, vaultAddress, distributionId, snapshot);
    if (tree === undefined) return 0; // Merkle distribution whose tree cannot be rebuilt; logged

    let sent = 0;
    let pending = false;
    const failures: Record<string, number> = { ...(dist.autoClaimFailures ?? {}) };
    let failuresChanged = false;
    const payouts: EvmDistributionPayout[] = [];
    // LP providers are paid through the vault's lpShareSource (`distributionClaimable` includes
    // their pool VT); the contract returns 0 for anyone with nothing to claim.
    const holders = tree
      ? [...tree.entries.keys()]
      : [...new Set([...Object.keys(snapshot.addressBalances ?? {}), ...Object.keys(snapshot.lpBalances ?? {})])];
    for (const holder of holders) {
      // A holder whose claim keeps reverting (e.g. a contract that rejects ETH) is skipped;
      // it can still claim itself until the deadline.
      if ((failures[holder] ?? 0) >= AUTO_CLAIM_MAX_FAILURES_PER_HOLDER) continue;
      const entry = tree?.entries.get(holder);
      const claimable = entry
        ? await this.merkleClaimable(
            vaultAddress,
            distributionId,
            holder as Address,
            entry.weight,
            BigInt(dist.netPot),
            BigInt(dist.supply)
          )
        : ((await this.contractReader.publicClient.readContract({
            address: vaultAddress,
            abi: VAULT_ABI,
            functionName: 'distributionClaimable',
            args: [distributionId, holder as Address],
          })) as bigint);
      if (claimable === 0n) continue;

      if (sent >= budget) {
        pending = true;
        break;
      }
      try {
        const result = await this.adminSigner.sendAndConfirm(
          entry
            ? {
                address: vaultAddress,
                abi: VAULT_ABI,
                functionName: 'claimDistributionWithProofFor',
                args: [distributionId, holder as Address, entry.weight, entry.proof],
              }
            : {
                address: vaultAddress,
                abi: VAULT_ABI,
                functionName: 'claimDistributionFor',
                args: [distributionId, holder as Address],
              },
          ['DistributionClaimed']
        );
        sent++;
        payouts.push({ holder, amount: String(claimable), txHash: result.hash, paidAt: new Date().toISOString() });
        this.logger.log(
          `Distribution ${dist.distributionId} on ${vaultAddress}: paid ${claimable} to ${holder} tx=${result.hash}`
        );
      } catch (err) {
        // Left for the next tick; the contract refuses a double payment.
        failures[holder] = (failures[holder] ?? 0) + 1;
        failuresChanged = true;
        if (failures[holder] < AUTO_CLAIM_MAX_FAILURES_PER_HOLDER) pending = true;
        this.logger.warn(
          `Distribution ${dist.distributionId} on ${vaultAddress}: claim for ${holder} failed ` +
            `(${failures[holder]}/${AUTO_CLAIM_MAX_FAILURES_PER_HOLDER}) — ${(err as Error).message}`
        );
      }
    }

    if (failuresChanged || payouts.length) await this.saveAutoClaimProgress(proposal, failures, payouts);
    if (!pending) await this.markAutoClaimDone(proposal, `paid ${sent} holder(s) this pass`);
    return sent;
  }

  private async saveAutoClaimProgress(
    proposal: Proposal,
    failures: Record<string, number>,
    payouts: EvmDistributionPayout[]
  ): Promise<void> {
    const fresh = await this.proposalRepository.findOne({ where: { id: proposal.id } });
    const current = fresh?.metadata?.evmDistribution;
    if (!current) return;
    await this.proposalRepository.update(
      { id: proposal.id },
      {
        metadata: {
          ...fresh.metadata,
          evmDistribution: {
            ...current,
            autoClaimFailures: failures,
            payouts: [...(current.payouts ?? []), ...payouts],
          },
        },
      }
    );
  }

  private async markAutoClaimDone(proposal: Proposal, reason: string): Promise<void> {
    const fresh = await this.proposalRepository.findOne({ where: { id: proposal.id } });
    if (!fresh?.metadata?.evmDistribution) return;
    await this.proposalRepository.update(
      { id: proposal.id },
      {
        metadata: {
          ...fresh.metadata,
          evmDistribution: { ...fresh.metadata.evmDistribution, autoClaimCompletedAt: new Date().toISOString() },
        },
      }
    );
    this.logger.log(`Distribution ${fresh.metadata.evmDistribution.distributionId} auto-claim complete (${reason})`);
  }

  /** What `holder` can claim right now: from the contract, or from the tree for a Merkle distribution. */
  async claimableFor(vaultId: string, distributionId: string, holder: Address): Promise<string> {
    const vault = await this.requireEvmVault(vaultId);
    const vaultAddress = vault.contract_address as Address;
    const id = BigInt(distributionId);

    if ((await this.readMerkleRoot(vaultAddress, id)) !== zeroHash) {
      const proposal = await this.proposalRepository
        .createQueryBuilder('p')
        .where('p.vault_id = :vaultId', { vaultId })
        .andWhere(`p.metadata->'evmDistribution'->>'distributionId' = :id`, { id: distributionId })
        .getOne();
      const onchain = await this.readDistribution(vault, id);
      const snapshot = proposal ? await this.snapshotForTimepoint(proposal, BigInt(onchain.timepoint)) : null;
      const tree = proposal && snapshot ? await this.treeForDistribution(proposal, vaultAddress, id, snapshot) : null;
      const entry = tree?.entries.get(holder.toLowerCase());
      if (!entry) return '0';
      return String(await this.merkleClaimable(vaultAddress, id, holder, entry.weight, onchain.netPot, onchain.supply));
    }

    const amount = (await this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'distributionClaimable',
      args: [id, holder],
    })) as bigint;
    return String(amount);
  }

  /**
   * How many addresses a distribution at `snapshot` pays: the same set the payout walks, direct VT
   * holders plus Uniswap LP providers (paid through lpShareSource), once per address, zero balances
   * ignored. LP balances are attributed on demand when the snapshot does not carry them yet; if that
   * fails the stored ones (or none) are used, so the count can only be low, never block the form.
   */
  private async recipientCount(snapshot: Snapshot | null, vaultAddress: Address): Promise<number> {
    if (!snapshot) return 0;
    let lp = snapshot.lpBalances ?? {};
    if (!snapshot.lpBalances) {
      try {
        lp = await this.evmSnapshotService.lpBalancesForSnapshot(snapshot, vaultAddress);
      } catch (err) {
        this.logger.warn(`LP attribution for snapshot ${snapshot.id} failed: ${(err as Error).message}`);
      }
    }
    return countSnapshotRecipients({ addressBalances: snapshot.addressBalances, lpBalances: lp });
  }

  async getDistributionInfo(vaultId: string, asset: string = zeroAddress) {
    const vault = await this.requireEvmVault(vaultId);
    const vaultAddress = vault.contract_address as Address;
    const snapshot = await this.latestSnapshot(vaultId);

    const available = await this.availableForDistribution(vaultAddress, asset as Address);
    const supply = snapshot?.snapshotTimepoint
      ? await this.circulatingSupplyAt(vaultAddress, BigInt(snapshot.snapshotTimepoint))
      : 0n;

    return {
      chain: ChainType.robinhood,
      // No treasury wallet on EVM — funds sit in the vault contract itself.
      vaultAddress,
      asset,
      availableAmount: String(available),
      vtHolderCount: await this.recipientCount(snapshot, vaultAddress),
      circulatingSupply: String(supply),
      timepoint: snapshot?.snapshotTimepoint ?? null,
      minClaimWindowSeconds: MIN_CLAIM_WINDOW_SECONDS,
      defaultClaimWindowSeconds: DEFAULT_CLAIM_WINDOW_SECONDS,
    };
  }

  // ---------------------------------------------------------------------------

  /**
   * The timepoint the payout is computed against — the proposal's own snapshot,
   * so a transfer made after the vote cannot move anyone's entitlement.
   *
   * Reconciles the snapshot against on-chain checkpoints first. Votes were
   * counted from `addressBalances` while the money follows `balanceOfAt`; if
   * those disagree the pot would not follow the weights the vote was decided
   * on, so this fails rather than opening the distribution.
   */
  private async resolveTimepoint(proposal: Proposal): Promise<bigint> {
    const recorded = proposal.metadata?.distributionTimepoint;
    if (recorded) return BigInt(recorded);

    const snapshot = proposal.snapshotId
      ? await this.snapshotRepository.findOne({ where: { id: proposal.snapshotId } })
      : await this.latestSnapshot(proposal.vaultId);

    if (!snapshot?.snapshotTimepoint) {
      throw new BadRequestException(
        `Proposal ${proposal.id} has no snapshot timepoint. A distribution cannot be opened without one — ` +
          `entitlement would otherwise be computed against an arbitrary moment.`
      );
    }

    const mismatches = await this.evmSnapshotService.reconcileWithChain(snapshot);
    if (mismatches.length > 0) {
      throw new Error(
        `Snapshot ${snapshot.id} disagrees with on-chain balances at timepoint ${snapshot.snapshotTimepoint} ` +
          `for ${mismatches.length} sampled holder(s), e.g. ${mismatches[0].address} ` +
          `(snapshot=${mismatches[0].snapshotBalance} chain=${mismatches[0].chainBalance}). ` +
          `Refusing to open a distribution whose payouts would not match the weights the vote was counted on.`
      );
    }

    return BigInt(snapshot.snapshotTimepoint);
  }

  private async availableForDistribution(vaultAddress: Address, asset: Address): Promise<bigint> {
    if (asset === zeroAddress) {
      return (await this.contractReader.publicClient.readContract({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: 'availableNativeForOperations',
      })) as bigint;
    }
    return (await this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'availableErc20ForOperations',
      args: [asset],
    })) as bigint;
  }

  private async circulatingSupplyAt(vaultAddress: Address, timepoint: bigint): Promise<bigint> {
    const vtAddress = (await this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'vaultToken',
    })) as Address;

    return (await this.contractReader.publicClient.readContract({
      address: vtAddress,
      abi: [
        {
          type: 'function',
          stateMutability: 'view',
          name: 'circulatingSupplyAt',
          inputs: [{ name: 'timepoint', type: 'uint256' }],
          outputs: [{ name: '', type: 'uint256' }],
        },
      ] as const,
      functionName: 'circulatingSupplyAt',
      args: [timepoint],
    })) as bigint;
  }

  private async readDistributionIdForKey(vaultAddress: Address, executionKey: Hex): Promise<bigint> {
    return (await this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'distributionIdForExecutionKey',
      args: [executionKey],
    })) as bigint;
  }

  private async readDistribution(vault: Vault, distributionId: bigint) {
    return (await this.contractReader.publicClient.readContract({
      address: vault.contract_address as Address,
      // V13 reorders the struct's tail; its own ABI decodes it.
      abi: vaultIsV13(vault) ? VAULT_V13_ABI : VAULT_ABI,
      functionName: 'getDistribution',
      args: [distributionId],
    })) as {
      asset: Address;
      timepoint: number;
      netPot: bigint;
      supply: bigint;
      paid: bigint;
      released: bigint;
      openedAt: bigint;
      deadline: bigint;
      swept: boolean;
    };
  }

  /** Vaults deployed before Merkle distributions have no `distributionMerkleRoot`. */
  private async supportsMerkleDistribution(vaultAddress: Address): Promise<boolean> {
    try {
      await this.readMerkleRoot(vaultAddress, 0n, false);
      return true;
    } catch {
      return false;
    }
  }

  /** `zeroHash` for a pro-rata distribution or a vault without Merkle support. */
  private async readMerkleRoot(vaultAddress: Address, distributionId: bigint, tolerateMissing = true): Promise<Hex> {
    try {
      return (await this.contractReader.publicClient.readContract({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: 'distributionMerkleRoot',
        args: [distributionId],
      })) as Hex;
    } catch (error) {
      if (tolerateMissing) return zeroHash;
      throw error;
    }
  }

  private buildTree(vaultAddress: Address, executionKey: Hex, snapshot: Snapshot): DistributionTree {
    return buildDistributionTree(
      vaultAddress,
      BigInt(this.contractReader.chainId),
      executionKey,
      votingBalances(snapshot)
    );
  }

  /**
   * The tree a Merkle distribution was opened with, rebuilt from its snapshot.
   * `null` for pro-rata; `undefined` when the rebuilt root does not match the
   * one on-chain (the snapshot changed), in which case nothing is paid.
   */
  private async treeForDistribution(
    proposal: Proposal,
    vaultAddress: Address,
    distributionId: bigint,
    snapshot: Snapshot
  ): Promise<DistributionTree | null | undefined> {
    const root = await this.readMerkleRoot(vaultAddress, distributionId);
    if (root === zeroHash) return null;
    const tree = this.buildTree(vaultAddress, this.buildExecutionKey(proposal.vaultId, proposal.id), snapshot);
    if (tree.root.toLowerCase() !== root.toLowerCase()) {
      this.logger.error(
        `Distribution ${distributionId} on ${vaultAddress}: rebuilt tree root ${tree.root} does not match on-chain ${root} ` +
          `(snapshot ${snapshot.id}). Not paying out; holders can still be paid once the snapshot is restored.`
      );
      return undefined;
    }
    return tree;
  }

  private async merkleClaimable(
    vaultAddress: Address,
    distributionId: bigint,
    holder: Address,
    weight: bigint,
    netPot: bigint,
    supply: bigint
  ): Promise<bigint> {
    const claimed = (await this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'isDistributionClaimed',
      args: [distributionId, holder],
    })) as boolean;
    return claimed || supply === 0n ? 0n : (weight * netPot) / supply;
  }

  /** The snapshot a distribution is weighted from: the one at its timepoint, else the proposal's. */
  /**
   * Writes LP providers' pool VT at `timepoint` into the factory's L4VALpShareRegistry and
   * freezes it. Skipped when LP payouts are off (`lpShareSource` = 0) or already recorded.
   * Refuses to write to a source that is not the registry configured for the vault's version.
   */
  private async recordLpShares(proposal: Proposal, vault: Vault, timepoint: bigint): Promise<void> {
    const client = this.contractReader.publicClient;
    const vaultAddress = vault.contract_address as Address;
    const factory = (await client.readContract({
      address: vaultAddress,
      abi: LP_SOURCE_ABI,
      functionName: 'factory',
    })) as Address;
    const source = (await client.readContract({
      address: factory,
      abi: LP_SOURCE_ABI,
      functionName: 'lpShareSource',
    })) as Address;
    if (source === zeroAddress) return;

    const expected = getEvmProtocolVersion(Number(vault.chain_id), vault.evm_protocol_version)?.lpShareRegistry;
    if (!expected || expected.toLowerCase() !== source.toLowerCase()) {
      throw new Error(
        `Vault ${vaultAddress}: factory lpShareSource ${source} is not the LP share registry configured for ` +
          `version ${vault.evm_protocol_version} (${expected ?? 'none'}); refusing to record LP shares there`
      );
    }
    const [, , finalized] = (await client.readContract({
      address: source,
      abi: LP_REGISTRY_ABI,
      functionName: 'recorded',
      args: [vaultAddress, zeroAddress, timepoint],
    })) as readonly [bigint, bigint, boolean];
    if (finalized) return;

    const snapshot = await this.snapshotForTimepoint(proposal, timepoint);
    if (!snapshot || String(snapshot.snapshotTimepoint) !== String(timepoint)) {
      throw new Error(`Proposal ${proposal.id}: no snapshot at timepoint ${timepoint} to attribute LP VT from`);
    }
    const lp = await this.evmSnapshotService.lpBalancesForSnapshot(snapshot, vaultAddress);
    const entries = Object.entries(lp).filter(([, vt]) => BigInt(vt) > 0n);
    for (let i = 0; i < entries.length; i += LP_RECORD_BATCH) {
      const chunk = entries.slice(i, i + LP_RECORD_BATCH);
      await this.adminSigner.sendAndConfirm(
        {
          address: source,
          abi: LP_REGISTRY_ABI,
          functionName: 'record',
          args: [vaultAddress, timepoint, chunk.map(([a]) => a as Address), chunk.map(([, vt]) => BigInt(vt))],
        },
        ['Recorded']
      );
    }
    await this.adminSigner.sendAndConfirm(
      { address: source, abi: LP_REGISTRY_ABI, functionName: 'finalize', args: [vaultAddress, timepoint] },
      ['Finalized']
    );
    const total = entries.reduce((sum, [, vt]) => sum + BigInt(vt), 0n);
    this.logger.log(
      `Proposal ${proposal.id}: recorded ${entries.length} LP provider(s), ${total} VT, at timepoint ${timepoint} in ${source}`
    );
  }

  private async snapshotForTimepoint(proposal: Proposal, timepoint: bigint): Promise<Snapshot | null> {
    return (
      (await this.snapshotRepository.findOne({
        where: { vaultId: proposal.vaultId, snapshotTimepoint: String(timepoint) },
      })) ??
      (proposal.snapshotId ? await this.snapshotRepository.findOne({ where: { id: proposal.snapshotId } }) : null)
    );
  }

  private async latestSnapshot(vaultId: string): Promise<Snapshot | null> {
    return this.snapshotRepository.findOne({ where: { vaultId }, order: { createdAt: 'DESC' } });
  }

  private async requireEvmVault(vaultId: string): Promise<Vault> {
    const vault = await this.vaultRepository.findOne({ where: { id: vaultId } });
    if (!vault) throw new NotFoundException(`Vault ${vaultId} not found`);
    if (vault.chain_type !== ChainType.robinhood) {
      throw new BadRequestException(`Vault ${vaultId} is not an EVM vault`);
    }
    if (!vault.contract_address) {
      throw new BadRequestException(`Vault ${vaultId} has no contract address`);
    }
    return vault;
  }
}
