import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { encodeAbiParameters, keccak256, zeroAddress, type Address, type Hex } from 'viem';

import { EvmAdminSigner } from '../../processing-tx/onchain/evm-admin-signer.service';
import { EvmContractReader } from '../../processing-tx/onchain/evm-contract-reader.service';
import { VAULT_ABI } from '../../processing-tx/onchain/vault.abi';

import { EvmSnapshotService } from './evm-snapshot.service';

import { Proposal } from '@/database/proposal.entity';
import { Snapshot } from '@/database/snapshot.entity';
import { Vault } from '@/database/vault.entity';
import { ProposalStatus, ProposalType } from '@/types/proposal.types';
import { ChainType } from '@/types/vault.types';

/** Matches `MIN_DISTRIBUTION_CLAIM_WINDOW` in Vault.sol. */
export const MIN_CLAIM_WINDOW_SECONDS = 90 * 24 * 60 * 60;

/** Default claim window. Generous on purpose: unclaimed funds go to treasury. */
export const DEFAULT_CLAIM_WINDOW_SECONDS = 180 * 24 * 60 * 60;

/** Most `claimDistributionFor` transactions sent per cron tick, across all distributions. */
const AUTO_CLAIM_MAX_PER_TICK = 50;

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
@Injectable()
export class EvmDistributionService {
  private readonly logger = new Logger(EvmDistributionService.name);

  constructor(
    @InjectRepository(Vault) private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Proposal) private readonly proposalRepository: Repository<Proposal>,
    @InjectRepository(Snapshot) private readonly snapshotRepository: Repository<Snapshot>,
    private readonly contractReader: EvmContractReader,
    private readonly adminSigner: EvmAdminSigner,
    private readonly evmSnapshotService: EvmSnapshotService
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
    const holderCount = snapshot ? Object.keys(snapshot.addressBalances ?? {}).length : 0;

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
      const onchain = await this.readDistribution(vaultAddress, existingId);
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

    const timepoint = await this.resolveTimepoint(proposal);

    // Re-check availability at execution time: the vote may have passed days
    // ago and the vault has been operating since.
    const available = await this.availableForDistribution(vaultAddress, asset);
    if (BigInt(amount) > available) {
      throw new BadRequestException(
        `Vault ${vaultAddress} has ${available} available for ${asset}, proposal requires ${amount}. ` +
          `The vault's balance moved after the vote passed.`
      );
    }

    const result = await this.adminSigner.sendAndConfirm(
      {
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: 'openDistribution',
        args: [executionKey, asset, BigInt(amount), Number(timepoint), BigInt(DEFAULT_CLAIM_WINDOW_SECONDS)],
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
        `asset=${asset} netPot=${opened.args.netPot} supply=${opened.args.supply} timepoint=${timepoint} tx=${result.hash}`
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
    }
  }

  private autoClaimRunning = false;

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
      const onchain = await this.readDistribution(vaultAddress, id);
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

    let sent = 0;
    let pending = false;
    for (const holder of Object.keys(snapshot.addressBalances ?? {})) {
      const claimable = (await this.contractReader.publicClient.readContract({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: 'distributionClaimable',
        args: [distributionId, holder as Address],
      })) as bigint;
      if (claimable === 0n) continue;

      if (sent >= budget) {
        pending = true;
        break;
      }
      try {
        const result = await this.adminSigner.sendAndConfirm(
          {
            address: vaultAddress,
            abi: VAULT_ABI,
            functionName: 'claimDistributionFor',
            args: [distributionId, holder as Address],
          },
          ['DistributionClaimed']
        );
        sent++;
        this.logger.log(
          `Distribution ${dist.distributionId} on ${vaultAddress}: paid ${claimable} to ${holder} tx=${result.hash}`
        );
      } catch (err) {
        // Left for the next tick; the contract refuses a double payment.
        pending = true;
        this.logger.warn(
          `Distribution ${dist.distributionId} on ${vaultAddress}: claim for ${holder} failed — ${(err as Error).message}`
        );
      }
    }

    if (!pending) await this.markAutoClaimDone(proposal, `paid ${sent} holder(s) this pass`);
    return sent;
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

  /** What `holder` can claim right now, straight from the contract. */
  async claimableFor(vaultId: string, distributionId: string, holder: Address): Promise<string> {
    const vault = await this.requireEvmVault(vaultId);
    const amount = (await this.contractReader.publicClient.readContract({
      address: vault.contract_address as Address,
      abi: VAULT_ABI,
      functionName: 'distributionClaimable',
      args: [BigInt(distributionId), holder],
    })) as bigint;
    return String(amount);
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
      vtHolderCount: snapshot ? Object.keys(snapshot.addressBalances ?? {}).length : 0,
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

  private async readDistribution(vaultAddress: Address, distributionId: bigint) {
    return (await this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
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
