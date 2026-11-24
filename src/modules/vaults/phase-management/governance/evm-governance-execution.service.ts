import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { parseAbi, zeroAddress, type Address } from 'viem';

import { EvmAdapterRegistryService } from '../../processing-tx/onchain/evm-adapter-registry.service';
import { EvmContractReader } from '../../processing-tx/onchain/evm-contract-reader.service';
import { EvmOpenCycleService, type EvmOpenCycleConfig } from '../../processing-tx/onchain/evm-open-cycle.service';
import { readVaultFrozen } from '../../processing-tx/onchain/evm-pause.service';
import {
  buildOperationId,
  encodeMockAdapterParams,
  EvmAssetKind,
  EvmPositionService,
  type SellNftParams,
} from '../../processing-tx/onchain/evm-position.service';
import { EvmSwapService } from '../../processing-tx/onchain/evm-swap.service';
import { EvmTerminationService } from '../../processing-tx/onchain/evm-termination.service';
import { EvmVaultOnchainStatus, VAULT_ABI } from '../../processing-tx/onchain/vault.abi';

import { EvmDistributionService } from './evm-distribution.service';
import { ProposalConditionsChangedError } from './proposal-errors';

import { isRpcRateLimitError } from '@/common/evm/evm-transport';
import { EvmExternalPosition } from '@/database/evm-external-position.entity';
import { Proposal } from '@/database/proposal.entity';
import { Vault } from '@/database/vault.entity';
import { IndexSwapRouteService } from '@/modules/vaults/index-vault/index-swap-route.service';
import { IndexVaultService } from '@/modules/vaults/index-vault/index-vault.service';
import { MarketplaceAction, ProposalStatus, ProposalType } from '@/types/proposal.types';
import { ChainType, VaultStatus } from '@/types/vault.types';

/** `executionError.errorCode` of a passed expansion queued behind a running one. */
/**
 * `executionError.errorCode` of a passed proposal waiting for the vault to reach a state the
 * contract accepts it in. Waiting never spends the retry budget; the retry cron re-checks it.
 */
export const PROPOSAL_WAIT_CODE = 'WAITING_FOR_VAULT_STATE';

const OUTSTANDING_ABI = parseAbi([
  'function totalOutstandingClaimVt() view returns (uint256)',
  'function totalOutstandingClaimNative() view returns (uint256)',
  'function totalOutstandingAcquireRefund() view returns (uint256)',
]);

/** Why a passed proposal waits, and what the proposal page says meanwhile. */
interface ProposalWait {
  reason: string;
  userFriendlyMessage: string;
}

type EvmGovernanceVaultRef = Pick<Vault, 'id' | 'vault_status' | 'chain_type'>;

/** The vault rejects `deadline == 0`; adapter calls get this much headroom. */
const TX_DEADLINE_SECONDS = 600n;

const txDeadline = (): bigint => BigInt(Math.floor(Date.now() / 1000)) + TX_DEADLINE_SECONDS;

/**
 * EVM-side execution for passed governance proposals.
 * Mirrors the Cardano execution paths in GovernanceExecutionService but
 * routes to on-chain EVM calls instead of Blockfrost / WayUp / DexHunter.
 *
 * Sprint 2 testnet strategy: all market-action proposal types route through
 * MockAdapter. Real adapter routing (Sprint 4) will be added per-type behind
 * the same interface.
 */
@Injectable()
export class EvmGovernanceExecutionService implements OnModuleInit {
  private readonly logger = new Logger(EvmGovernanceExecutionService.name);

  /**
   * Why the last attempt of a proposal failed, set by {@link fail} and stored on the proposal by
   * `executeProposal`, so retries, the UI and the "gave up" alert can show it. A proposal is
   * executed under a lock, so one entry per proposal id cannot be overwritten by another run.
   */
  private readonly failures = new Map<string, string>();

  /** Log an execution failure, remember it for the proposal, and return `false`. */
  private fail(proposal: Proposal, message: string): false {
    this.logger.error(message);
    this.failures.set(proposal.id, message);
    return false;
  }
  private readonly isTestnet: boolean;
  private readonly mockAdapterAddress: Address | null;
  /**
   * Marketplace adapter used for NFT sales when a proposal does not name one.
   * Null until a real marketplace integration exists — there is no production
   * NFT marketplace on chain 46630 today, so NFT sale proposals must carry their
   * own adapter until one is deployed and approved in the AdapterRegistry.
   */
  private readonly nftSaleAdapterAddress: Address | null;
  /** Default swap slippage in basis points (0.5%). Configurable via EVM_SWAP_SLIPPAGE_BPS. */
  private readonly swapSlippageBps: number;

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Proposal)
    private readonly proposalRepository: Repository<Proposal>,
    @InjectRepository(EvmExternalPosition)
    private readonly positionsRepository: Repository<EvmExternalPosition>,
    private readonly positionService: EvmPositionService,
    private readonly terminationService: EvmTerminationService,
    private readonly contractReader: EvmContractReader,
    private readonly distributionService: EvmDistributionService,
    private readonly adapterRegistryService: EvmAdapterRegistryService,
    private readonly swapService: EvmSwapService,
    private readonly swapRouteService: IndexSwapRouteService,
    private readonly evmOpenCycleService: EvmOpenCycleService,
    private readonly indexVaultService: IndexVaultService,
    configService: ConfigService
  ) {
    // EVM vaults run on Robinhood: testnet is decided by the EVM chain (4663 = mainnet),
    // not by CARDANO_NETWORK — a stack can run Robinhood mainnet next to Cardano preprod.
    this.isTestnet = Number(configService.get<string>('EVM_CHAIN_ID')) !== 4663;
    const raw = configService.get<string>('EVM_MOCK_ADAPTER_ADDRESS');
    this.mockAdapterAddress = raw ? (raw as Address) : null;
    const nftSaleRaw = configService.get<string>('EVM_NFT_SALE_ADAPTER_ADDRESS');
    this.nftSaleAdapterAddress = nftSaleRaw ? (nftSaleRaw as Address) : null;
    this.swapSlippageBps = Number(configService.get<string>('EVM_SWAP_SLIPPAGE_BPS') ?? '50');
  }

  /**
   * Ensure the MockAdapter is approved in the registry at startup so governance
   * executions don't fail on testnet with "NotApprovedAdapter".
   */
  async onModuleInit(): Promise<void> {
    if (!this.isTestnet || !this.mockAdapterAddress) return;
    try {
      const already = await this.adapterRegistryService.isApproved(this.mockAdapterAddress);
      if (!already) {
        await this.adapterRegistryService.approveAdapter(this.mockAdapterAddress, 'mock');
        this.logger.log(`MockAdapter ${this.mockAdapterAddress} approved in AdapterRegistry on startup`);
      }
    } catch (err) {
      // Non-fatal: governance proposals will fail at execution time with a clear error
      this.logger.warn(`Failed to approve MockAdapter on startup: ${(err as Error).message}`);
    }
  }

  /**
   * Entry point called by GovernanceExecutionService when `vault.chain_type === 'robinhood'`.
   * Returns `true` on success so the caller can mark the proposal EXECUTED.
   */
  async executeProposal(proposal: Proposal, vault: EvmGovernanceVaultRef): Promise<boolean> {
    let wait: ProposalWait | null;
    try {
      wait = await this.waitReason(proposal, vault.id);
    } catch (err) {
      if (err instanceof ProposalConditionsChangedError) throw err;
      // An RPC hiccup (e.g. 429 on a free endpoint) while checking is not a failed attempt: wait
      // and check again on the next tick instead of spending the retry budget.
      this.logger.warn(`Proposal ${proposal.id}: could not check the vault state — ${(err as Error).message}`);
      wait = {
        reason: 'the vault state could not be read; checking again shortly',
        userFriendlyMessage: 'Checking whether this proposal can run; it will continue automatically.',
      };
    }
    if (wait) {
      await this.markWaiting(proposal, wait);
      return false;
    }

    this.failures.delete(proposal.id);
    try {
      const ok = await this.dispatch(proposal, vault);
      if (ok) return true;
      const reason = this.failures.get(proposal.id) ?? null;
      if (reason && isRpcRateLimitError(reason)) {
        // The RPC node was overloaded, nothing about the proposal is wrong: wait and continue on
        // the next tick without spending the retry budget. Steps already done are not repeated
        // (each swap has its own operation id; termination resumes at the step it reached).
        await this.markWaiting(proposal, {
          reason: 'the RPC node is rate-limiting requests; continuing shortly',
          userFriendlyMessage: 'Execution is paused for a moment and will continue automatically.',
        });
        return false;
      }
      await this.recordFailure(proposal, reason);
      return false;
    } finally {
      this.failures.delete(proposal.id);
    }
  }

  /** Stores why an attempt failed, so retries, the UI and the "gave up" alert can show it. */
  private async recordFailure(proposal: Proposal, lastError: string | null): Promise<void> {
    try {
      const fresh = await this.proposalRepository.findOne({ where: { id: proposal.id }, select: ['id', 'metadata'] });
      const metadata = { ...(fresh?.metadata ?? proposal.metadata) };
      metadata.executionError = {
        message: lastError ?? `Execution of ${proposal.proposalType} returned no result and logged no error.`,
        timestamp: new Date().toISOString(),
        errorCode: 'EVM_EXECUTION_FAILED',
        userFriendlyMessage: 'Execution failed; it will be retried automatically.',
      };
      await this.proposalRepository.update({ id: proposal.id }, { metadata });
    } catch (err) {
      this.logger.warn(`Proposal ${proposal.id}: could not store the execution error — ${(err as Error).message}`);
    }
  }

  private async dispatch(proposal: Proposal, vault: EvmGovernanceVaultRef): Promise<boolean> {
    switch (proposal.proposalType) {
      case ProposalType.MARKETPLACE_ACTION:
      case ProposalType.BUY_SELL:
        return this.executeMarketAction(proposal, vault);

      case ProposalType.STAKING:
        return this.executeStakingAction(proposal, vault);

      case ProposalType.TERMINATION:
        return this.executeTermination(proposal, vault);

      case ProposalType.DISTRIBUTION:
        return this.executeDistribution(proposal);

      case ProposalType.BURNING:
        // No VT burn governance equivalent on EVM yet.
        this.logger.warn(`Proposal ${proposal.id}: BURNING not supported on EVM — skipping`);
        return false;

      case ProposalType.EXPANSION:
        return this.executeEvmExpansion(proposal, vault);

      case ProposalType.ACQUIRE_EXPANSION:
        return this.executeEvmAcquireExpansion(proposal, vault);

      case ProposalType.INDEX_REWEIGHT:
        return this.indexVaultService.executeReweightProposal(proposal);

      default:
        this.logger.warn(`Proposal ${proposal.id}: unknown type ${proposal.proposalType} for EVM execution`);
        return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Expansion: open a new cycle with an asset-contribution window
  // ---------------------------------------------------------------------------

  /**
   * Conditions a passed proposal waits for instead of failing on-chain. A proposal created while
   * the vault was locked can pass while an expansion runs, or right after a cycle closed while its
   * VT are still unclaimed; the contract refuses it then, and five quick retries would give up long
   * before the vault is ready. These wait with no time limit and run once the vault is free.
   */
  private async waitReason(proposal: Proposal, vaultId: string): Promise<ProposalWait | null> {
    const v = await this.vaultRepository.findOne({
      where: { id: vaultId },
      select: ['id', 'vault_status', 'evm_current_cycle_id', 'vault_archetype', 'contract_address'],
    });
    if (!v) return null;
    // While the guardian has frozen the vault (or every vault), every authority call reverts
    // (VaultFrozen). A freeze can outlast the retry budget, so any proposal waits it out.
    if (
      v.contract_address &&
      (await readVaultFrozen(this.contractReader.publicClient, v.contract_address as Address))
    ) {
      return {
        reason: 'the vault is frozen by the guardian',
        userFriendlyMessage:
          'The vault is temporarily frozen for a safety review. This proposal runs once it is unfrozen.',
      };
    }
    const locked = v.vault_status === VaultStatus.locked;
    const afterExpansion =
      'This proposal runs automatically once the current expansion has finished and the vault is locked again.';

    switch (proposal.proposalType) {
      case ProposalType.EXPANSION:
      case ProposalType.ACQUIRE_EXPANSION: {
        // `openCycle` needs a locked vault; the last cycle's LP seed and basket buy run only then.
        if (!locked) return { reason: 'another expansion is still running', userFriendlyMessage: afterExpansion };
        const pending = await this.indexVaultService.postLockWorkPending(v);
        return pending ? { reason: pending, userFriendlyMessage: afterExpansion } : null;
      }

      case ProposalType.TERMINATION: {
        // A retry after preparing resumes there; only the first step waits.
        if ((await this.terminationService.onchainStatus(v.id)) === EvmVaultOnchainStatus.TerminationPreparing) {
          return null;
        }
        if (!locked) return { reason: 'an expansion is still running', userFriendlyMessage: afterExpansion };
        const owed = await this.outstanding(v.contract_address as Address);
        if (owed) {
          return {
            reason: `${owed} still to be claimed from the last cycle`,
            userFriendlyMessage:
              'Termination starts automatically once every vault token and ETH from the last cycle has been claimed.',
          };
        }
        return null;
      }

      case ProposalType.DISTRIBUTION: {
        // Once termination has started, `openDistribution` can never run (it needs Active or Locked);
        // the free assets go to VT holders through the termination instead.
        const onchain = await this.terminationService.onchainStatus(v.id);
        if (onchain !== EvmVaultOnchainStatus.Active && onchain !== EvmVaultOnchainStatus.Locked) {
          throw new ProposalConditionsChangedError(
            'The vault is being terminated, so this distribution can no longer be opened. ' +
              'Its free assets are paid to VT holders through the termination.'
          );
        }
        // `openDistribution` reverts while allocated VT is unminted: the snapshot supply would miss it.
        const owed = await this.outstanding(v.contract_address as Address, true);
        if (owed) {
          return {
            reason: `${owed} still to be claimed from the last cycle`,
            userFriendlyMessage:
              'The distribution opens automatically once the vault tokens from the last cycle have been claimed.',
          };
        }
        return null;
      }

      // Swaps, marketplace actions, staking and re-weights do not wait for an expansion: the contract
      // trades only `availableNativeForOperations` / `availableErc20`, which leave out the open
      // cycle's ETH and refundable contributions, and `swap` runs while a cycle is Active.

      default:
        return null;
    }
  }

  /**
   * What the vault still owes from closed cycles, read on-chain; null when nothing. `vtOnly` checks
   * just allocated VT (what blocks a distribution). A vault without these views (pre-V13) owes none.
   */
  private async outstanding(vaultAddress: Address, vtOnly = false): Promise<string | null> {
    const read = (
      functionName: 'totalOutstandingClaimVt' | 'totalOutstandingClaimNative' | 'totalOutstandingAcquireRefund'
    ) =>
      this.contractReader.publicClient
        .readContract({ address: vaultAddress, abi: OUTSTANDING_ABI, functionName })
        .then(v => v as bigint)
        .catch(() => 0n);
    const vt = await read('totalOutstandingClaimVt');
    if (vtOnly) return vt > 0n ? 'vault tokens' : null;
    const [native, refund] = await Promise.all([
      read('totalOutstandingClaimNative'),
      read('totalOutstandingAcquireRefund'),
    ]);
    const owed = [vt > 0n && 'vault tokens', native > 0n && 'ETH', refund > 0n && 'acquire refunds'].filter(Boolean);
    return owed.length ? owed.join(', ') : null;
  }

  private async markWaiting(proposal: Proposal, wait: ProposalWait): Promise<void> {
    const fresh = await this.proposalRepository.findOne({ where: { id: proposal.id }, select: ['id', 'metadata'] });
    const metadata = { ...(fresh?.metadata ?? proposal.metadata) };
    if (metadata.executionError?.errorCode !== PROPOSAL_WAIT_CODE || metadata.executionError?.reason !== wait.reason) {
      this.logger.log(`Proposal ${proposal.id} (${proposal.proposalType}) waiting: ${wait.reason}`);
    }
    const previous = metadata.executionError?.errorCode === PROPOSAL_WAIT_CODE ? metadata.executionError : undefined;
    metadata.executionError = {
      message: `Waiting: ${wait.reason}.`,
      reason: wait.reason,
      timestamp: new Date().toISOString(),
      errorCode: PROPOSAL_WAIT_CODE,
      userFriendlyMessage: wait.userFriendlyMessage,
      // Kept across checks: when the wait began, and whether the "waiting too long" alert went out.
      waitingSince: previous?.waitingSince ?? new Date().toISOString(),
      waitingAlertedAt: previous?.waitingAlertedAt,
    };
    // Waiting is not a failed attempt: keep the retry budget for real failures.
    delete metadata._executionRetry;
    await this.proposalRepository.update({ id: proposal.id }, { metadata });
  }

  private async executeEvmExpansion(proposal: Proposal, vault: EvmGovernanceVaultRef): Promise<boolean> {
    const cfg = proposal.metadata?.expansion;
    if (!cfg) {
      this.logger.warn(`Proposal ${proposal.id}: missing expansion metadata`);
      return false;
    }

    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const ONE_YEAR_S = BigInt(365 * 24 * 3600);
    const durationS = cfg.noLimit ? ONE_YEAR_S : BigInt(Math.floor((cfg.duration ?? 0) / 1000));
    const assetWhitelist: Address[] = (cfg.evmAssets ?? []).map(
      (a: { contractAddress: string }) => a.contractAddress as Address
    );

    const cycleCfg: EvmOpenCycleConfig = {
      assetWindow: { start: nowSec, end: nowSec + durationS },
      acquireWindow: { start: 0n, end: 0n },
      minAcquireThreshold: 0n,
      adaPairVtPerNativeUnit: 0n,
      assetWhitelist,
      contributorWhitelist: [],
    };

    try {
      const { txHash, cycleId } = await this.evmOpenCycleService.openCycleForVault(vault.id, cycleCfg);

      // openCycleForVault sets vault_status = acquire; override to expansion so
      // governance restrictions and lifecycle queries recognise the window type.
      // Also reset committed-root fields so the lifecycle cron picks up the new cycle.
      await this.vaultRepository.update(
        { id: vault.id },
        {
          vault_status: VaultStatus.expansion,
          expansion_phase_start: new Date(),
          expansion_duration: cfg.noLimit ? 365 * 24 * 3600 * 1000 : cfg.duration,
          evm_current_cycle_id: cycleId.toString(),
          evm_root_committed_at: null,
          evm_close_cycle_tx_hash: null,
        }
      );

      this.logger.log(`EVM expansion cycle opened for vault ${vault.id} cycleId=${cycleId} tx=${txHash}`);
      return true;
    } catch (err) {
      return this.fail(
        proposal,
        `EVM expansion openCycle failed for proposal ${proposal.id}: ${(err as Error).message}`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Acquire expansion: open a new cycle with a native-currency (ETH) acquire window
  // ---------------------------------------------------------------------------

  private async executeEvmAcquireExpansion(proposal: Proposal, vault: EvmGovernanceVaultRef): Promise<boolean> {
    const cfg = proposal.metadata?.acquireExpansion;
    if (!cfg) {
      this.logger.warn(`Proposal ${proposal.id}: missing acquireExpansion metadata`);
      return false;
    }

    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const ONE_YEAR_S = BigInt(365 * 24 * 3600);
    const durationS = cfg.noLimit ? ONE_YEAR_S : BigInt(Math.floor((cfg.duration ?? 0) / 1000));

    const cycleCfg: EvmOpenCycleConfig = {
      assetWindow: { start: 0n, end: 0n },
      acquireWindow: { start: nowSec, end: nowSec + durationS },
      minAcquireThreshold: 0n,
      adaPairVtPerNativeUnit: 0n,
      assetWhitelist: [],
      contributorWhitelist: [],
    };

    try {
      const { txHash, cycleId } = await this.evmOpenCycleService.openCycleForVault(vault.id, cycleCfg);

      await this.vaultRepository.update(
        { id: vault.id },
        {
          vault_status: VaultStatus.acquire_expansion,
          expansion_phase_start: new Date(),
          expansion_duration: cfg.noLimit ? 365 * 24 * 3600 * 1000 : cfg.duration,
          evm_current_cycle_id: cycleId.toString(),
          evm_root_committed_at: null,
          evm_close_cycle_tx_hash: null,
        }
      );

      this.logger.log(`EVM acquire expansion cycle opened for vault ${vault.id} cycleId=${cycleId} tx=${txHash}`);
      return true;
    } catch (err) {
      return this.fail(
        proposal,
        `EVM acquire expansion openCycle failed for proposal ${proposal.id}: ${(err as Error).message}`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Market actions → openPosition via adapter
  // ---------------------------------------------------------------------------

  private async executeMarketAction(proposal: Proposal, vault: EvmGovernanceVaultRef): Promise<boolean> {
    const actions = proposal.metadata?.marketplaceActions ?? [];
    if (actions.length === 0) {
      this.logger.warn(`Proposal ${proposal.id}: no marketplaceActions in metadata`);
      return false;
    }

    // NFT sells are routed to `Vault.sellNft`, not `openPosition`. The two are
    // not interchangeable: `openPosition` handles only native and ERC-20 input,
    // so an NFT sale sent there can never execute. Everything else (token swaps,
    // position closes) keeps its existing path.
    const nftSells: { action: any; index: number }[] = [];
    const rest: { action: any; index: number }[] = [];
    for (let i = 0; i < actions.length; i++) {
      (this._isNftSell(actions[i]) ? nftSells : rest).push({
        action: actions[i],
        index: i,
      });
    }

    if (nftSells.length > 0) {
      const ok = await this.executeNftSales(proposal, vault, nftSells);
      if (!ok) return false;
      if (rest.length === 0) return true;
    }

    const remaining = rest.map(r => r.action);
    if (this.isTestnet) {
      return this.executeMarketActionMock(proposal, vault, remaining);
    }

    return this.executeMarketActionSwap(proposal, vault, remaining);
  }

  /** A SELL whose subject is an on-chain NFT rather than a fungible token. */
  private _isNftSell(action: any): boolean {
    const isSell = action?.exec === MarketplaceAction.SELL || action?.action === MarketplaceAction.SELL;
    if (!isSell) return false;
    const kind = Number(action?.assetKind ?? action?.kind);
    return kind === EvmAssetKind.ERC721 || kind === EvmAssetKind.ERC1155;
  }

  /**
   * Execute governance-approved NFT sales.
   *
   * Termination distributes only native and ERC-20, so a vault holding an NFT
   * cannot wind down until it is sold. Every parameter comes from the passed
   * proposal — nothing is recomputed here — and `operationId` is derived from
   * (vault, proposal, action index), so a retry after a lost receipt reverts
   * on-chain instead of selling the asset twice.
   */
  private async executeNftSales(
    proposal: Proposal,
    vault: EvmGovernanceVaultRef,
    entries: { action: any; index: number }[]
  ): Promise<boolean> {
    for (const { action, index } of entries) {
      const nftContract = action.nftContract as Address | undefined;
      const adapter = (action.adapter ?? this.nftSaleAdapterAddress) as Address | undefined;

      if (!nftContract || !adapter) {
        return this.fail(
          proposal,
          `Proposal ${proposal.id} action[${index}]: NFT sale needs nftContract and an adapter ` +
            `(none passed and EVM_NFT_SALE_ADAPTER_ADDRESS is unset)`
        );
      }

      const kind = Number(action.assetKind ?? action.kind) as EvmAssetKind.ERC721 | EvmAssetKind.ERC1155;
      const tokenId = BigInt(action.tokenId ?? 0);
      const quantity = kind === EvmAssetKind.ERC721 ? 1n : BigInt(action.quantity ?? action.amount ?? 0);

      // The vault refuses to sell a slot that still backs a refundable
      // contribution. Records in a Locked cycle can never be refunded, so
      // releasing them is a safe preflight; anything still genuinely refundable
      // will make the sale revert, which is the intended protection.
      const contributionIds: bigint[] = (action.contributionIds ?? []).map((c: string | number) => BigInt(c));
      for (const contributionId of contributionIds) {
        try {
          await this.positionService.releaseNftRefundable(vault.id, contributionId);
        } catch (err) {
          // Already released is the common case and is not an error.
          this.logger.debug(
            `Proposal ${proposal.id} action[${index}]: releaseNftRefundable(${contributionId}) ` +
              `skipped — ${(err as Error).message}`
          );
        }
      }

      const params: SellNftParams = {
        operationId: buildOperationId(vault.id, proposal.id, index),
        adapter,
        nftContract,
        tokenId,
        quantity,
        kind,
        paymentAsset: (action.paymentAsset ?? '0x0000000000000000000000000000000000000000') as Address,
        minNetProceeds: BigInt(action.minNetProceeds ?? 0),
        deadline: BigInt(action.deadline ?? 0),
        protocolParams: (action.protocolParams ?? '0x') as `0x${string}`,
      };

      if (params.deadline === 0n) {
        return this.fail(
          proposal,
          `Proposal ${proposal.id} action[${index}]: NFT sale needs a non-zero deadline — the vault rejects 0`
        );
      }

      try {
        const res = await this.positionService.sellNft(vault.id, params);
        this.logger.log(
          `Proposal ${proposal.id} action[${index}]: sold ${nftContract}#${tokenId} ` +
            `gross=${res.grossProceeds} net=${res.netProceeds} tx=${res.txHash}`
        );
      } catch (err) {
        return this.fail(
          proposal,
          `Proposal ${proposal.id} action[${index}]: sellNft failed — ${(err as Error).message}`
        );
      }
    }

    return true;
  }

  /**
   * Mainnet token trades go through the vault's position-less `swap` on the
   * `swap`-tagged UniversalRouter adapter (`EVM_SWAP_ADAPTER_ADDRESS`), the same
   * path index vaults use. `operationId` is derived from (vault, proposal,
   * action index), so a retry after a lost receipt reverts instead of trading
   * twice.
   */
  /**
   * Before the first swap, the vault's free balance must still cover every swap the proposal has
   * not run yet, per input asset. If it does not (other proposals or distributions spent it since
   * the vote), the proposal cannot run as voted: it is rejected, and no swap of it runs, so it is
   * never left half done.
   */
  private async assertSwapsStillCovered(
    proposal: Proposal,
    vaultId: string,
    vaultAddress: Address,
    actions: any[]
  ): Promise<void> {
    const needed = new Map<string, bigint>();
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      if (action.exec === 'CLOSE_POSITION') continue;
      const assetIn = String(action.inputAsset ?? action.policyId ?? zeroAddress).toLowerCase();
      const assetOut = String(action.expectedOutputAsset ?? action.outputAsset ?? zeroAddress).toLowerCase();
      const amountIn = BigInt(action.amount ?? action.quantity ?? 0);
      if (amountIn === 0n || assetIn === assetOut) continue;
      // A swap that already ran (an earlier attempt) is not counted again.
      if (await this.swapService.isOperationIdUsed(vaultAddress, buildOperationId(vaultId, proposal.id, i))) continue;
      needed.set(assetIn, (needed.get(assetIn) ?? 0n) + amountIn);
    }

    for (const [asset, amount] of needed) {
      const native = asset === zeroAddress;
      const available = (await this.contractReader.publicClient.readContract(
        native
          ? { address: vaultAddress, abi: VAULT_ABI, functionName: 'availableNativeForOperations' }
          : {
              address: vaultAddress,
              abi: VAULT_ABI,
              functionName: 'availableErc20ForOperations',
              args: [asset as Address],
            }
      )) as bigint;
      if (amount > available) {
        throw new ProposalConditionsChangedError(
          `The vault no longer has enough ${native ? 'ETH' : `of ${asset}`} free for this proposal's trades ` +
            `(needs ${amount}, ${available} available in base units).`
        );
      }
    }
  }

  private async executeMarketActionSwap(
    proposal: Proposal,
    vault: EvmGovernanceVaultRef,
    actions: any[]
  ): Promise<boolean> {
    const vaultRow = await this.vaultRepository.findOne({
      where: { id: vault.id },
      select: ['id', 'contract_address', 'chain_id', 'evm_protocol_version'],
    });
    const vaultAddress = vaultRow?.contract_address as Address | undefined;
    if (!vaultRow || !vaultAddress) {
      return this.fail(proposal, `Proposal ${proposal.id}: vault ${vault.id} has no contract address`);
    }

    let adapter: Address;
    try {
      adapter = this.swapRouteService.tradingAdapterFor(vaultRow);
    } catch (err) {
      return this.fail(proposal, `Cannot execute market proposal ${proposal.id}: ${(err as Error).message}`);
    }

    let tradeFeeBps: number;
    try {
      tradeFeeBps = await this.swapService.tradeFeeBps(vaultAddress);
    } catch (err) {
      return this.fail(proposal, `Proposal ${proposal.id}: failed to read trade fee — ${(err as Error).message}`);
    }

    await this.assertSwapsStillCovered(proposal, vault.id, vaultAddress, actions);

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];

      // Swap-adapter trades leave no position behind, so there is nothing to close.
      if (action.exec === 'CLOSE_POSITION') {
        return this.fail(
          proposal,
          `Proposal ${proposal.id} action[${i}]: CLOSE_POSITION is not supported — trades settle in one swap`
        );
      }

      const assetIn: Address = action.inputAsset ?? action.policyId ?? '0x0000000000000000000000000000000000000000';
      const assetOut: Address =
        action.expectedOutputAsset ?? action.outputAsset ?? '0x0000000000000000000000000000000000000000';
      const amountIn = BigInt(action.amount ?? action.quantity ?? 0);

      if (amountIn === 0n || assetIn.toLowerCase() === assetOut.toLowerCase()) continue;

      const operationId = buildOperationId(vault.id, proposal.id, i);

      try {
        if (await this.swapService.isOperationIdUsed(vaultAddress, operationId)) {
          this.logger.log(`Proposal ${proposal.id} action[${i}]: operation already executed — skipping`);
          continue;
        }

        // Same routing as index rebalances: the floor comes from simulating this exact swap.
        const { params } = await this.swapRouteService.prepareSwap({
          vaultAddress,
          adapter,
          operationId,
          assetIn,
          assetOut,
          amountIn,
          deadline: txDeadline(),
          slippageBps: this.swapSlippageBps,
          tradeFeeBps,
        });

        const res = await this.swapService.swap(vault.id, params, { proposalId: proposal.id });

        this.logger.log(
          `Proposal ${proposal.id} action[${i}]: swap ${assetIn}→${assetOut} ` +
            `grossOut=${res.grossOut} fee=${res.fee} tx=${res.txHash}`
        );
      } catch (err) {
        return this.fail(proposal, `Proposal ${proposal.id} action[${i}]: swap failed — ${(err as Error).message}`);
      }
    }

    return true;
  }

  private async executeMarketActionMock(
    proposal: Proposal,
    vault: EvmGovernanceVaultRef,
    actions: any[]
  ): Promise<boolean> {
    if (!this.mockAdapterAddress) {
      return this.fail(
        proposal,
        `EVM_MOCK_ADAPTER_ADDRESS is not configured — cannot execute testnet market proposal ${proposal.id}`
      );
    }

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const inputAmountRaw = BigInt(action.amount ?? action.quantity ?? 0);
      if (inputAmountRaw === 0n) continue;

      const operationId = buildOperationId(vault.id, proposal.id, i);
      const protocolParams = encodeMockAdapterParams(inputAmountRaw, 10000n);
      const inputAsset: Address = action.inputAsset ?? action.policyId ?? '0x0000000000000000000000000000000000000000';

      try {
        await this.positionService.openPosition(vault.id, {
          operationId,
          adapter: this.mockAdapterAddress,
          protocol: '0x0000000000000000000000000000000000000000',
          inputAsset,
          maxInputAmount: inputAmountRaw,
          expectedPositionAsset: inputAsset,
          minExpectedOutput: 1n, // mock always succeeds
          deadline: txDeadline(),
          protocolParams,
        });

        this.logger.log(`Proposal ${proposal.id} action[${i}]: openPosition via MockAdapter — ok`);
      } catch (err) {
        return this.fail(
          proposal,
          `Proposal ${proposal.id} action[${i}]: openPosition failed — ${(err as Error).message}`
        );
      }
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Staking → openPosition via staking adapter
  // ---------------------------------------------------------------------------

  private async executeStakingAction(proposal: Proposal, vault: EvmGovernanceVaultRef): Promise<boolean> {
    const fts = proposal.metadata?.fungibleTokens ?? [];
    const nfts = proposal.metadata?.nonFungibleTokens ?? [];
    const all = [...fts, ...nfts];

    if (all.length === 0) {
      this.logger.warn(`Proposal ${proposal.id}: no tokens to stake in metadata`);
      return false;
    }

    if (this.isTestnet) {
      // Treat staking the same as market action on testnet: use MockAdapter
      return this.executeMarketActionMock(
        proposal,
        vault,
        all.map(t => ({
          inputAsset: '0x0000000000000000000000000000000000000000',
          amount: (t as any).amount ?? 1,
        }))
      );
    }

    this.logger.warn(`Proposal ${proposal.id}: mainnet staking adapter not yet implemented`);
    return false;
  }

  // ---------------------------------------------------------------------------
  // Termination → beginTerminationPreparing → beginTermination
  // ---------------------------------------------------------------------------

  /**
   * A passed TERMINATION proposal drives both on-chain steps.
   *
   * Step 1 carries the strict liquidity preflight, because
   * `TerminationPreparing` is a one-way door: `openCycle` accepts only
   * Locked/Cancelled and the sole exit is `beginTermination`, so a vault that
   * enters and then cannot commit is bricked rather than delayed. If step 1
   * succeeds and step 2 fails, the vault is left in `TerminationPreparing` and
   * the proposal is NOT marked executed; the automatic proposal retry (or
   * `retryTermination`) resumes at step 2.
   *
   * The distributable set comes from the vault's own `custodyTokens()`
   * registry, not from `evm_external_positions`. The old position-derived list
   * was not the set of assets the vault holds — it missed contributed ERC-20s,
   * returned underlying and LP tokens — and the contract's coverage check now
   * rejects any commit that leaves a held asset uncovered.
   */
  private async executeTermination(proposal: Proposal, vault: EvmGovernanceVaultRef): Promise<boolean> {
    let prepared = false;
    try {
      // A retry after step 2 failed finds the vault already in TerminationPreparing: step 1
      // would now always revert ("must be Locked or Cancelled"), so resume at step 2.
      if ((await this.terminationService.onchainStatus(vault.id)) === EvmVaultOnchainStatus.TerminationPreparing) {
        prepared = true;
        this.logger.warn(
          `Proposal ${proposal.id}: vault ${vault.id} already in TerminationPreparing; resuming at beginTermination`
        );
      } else {
        await this.terminationService.beginTerminationPreparing(vault.id);
        prepared = true;
        this.logger.log(`Proposal ${proposal.id}: beginTerminationPreparing submitted (preflight passed)`);
      }

      const result = await this.terminationService.beginTermination(vault.id);
      this.logger.log(
        `Proposal ${proposal.id}: beginTermination committed — ${result.rows.length} distributable asset(s), ` +
          `claim window closes at ${result.terminationDeadline}`
      );

      return true;
    } catch (err) {
      const message = (err as Error).message;
      if (prepared) {
        return this.fail(
          proposal,
          `Proposal ${proposal.id}: vault ${vault.id} is in TerminationPreparing but the rate commit failed — ` +
            `${message}. The vault cannot open cycles or terminate until beginTermination succeeds; ` +
            `fix the cause and call retryTermination.`
        );
      }
      return this.fail(proposal, `Proposal ${proposal.id}: EVM termination failed before preparing — ${message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Distribution → openDistribution
  // ---------------------------------------------------------------------------

  /**
   * A passed DISTRIBUTION proposal reserves its pot on the vault contract.
   *
   * This previously returned `true` on a log line, on the premise that the
   * airdrop orchestrator handled distributions. It does not — that pipeline
   * pushes acquire-phase allocation claims and has no concept of a proposal, so
   * a passed distribution was marked EXECUTED while moving no funds at all.
   *
   * Failure returns `false` rather than throwing past the caller so the
   * proposal stays retryable. That is safe to retry because
   * `EvmDistributionService` reconciles against the on-chain execution key
   * first: a submission that landed but lost its receipt is adopted, never
   * re-opened.
   */
  private async executeDistribution(proposal: Proposal): Promise<boolean> {
    try {
      const result = await this.distributionService.executeDistribution(proposal);

      await this.proposalRepository.update(
        { id: proposal.id },
        {
          metadata: {
            ...proposal.metadata,
            evmDistribution: {
              distributionId: result.distributionId,
              asset: result.asset,
              netPot: result.netPot,
              supply: result.supply,
              timepoint: result.timepoint,
              deadline: result.deadline,
              txHash: result.txHash,
              openedAt: new Date().toISOString(),
            },
          },
        }
      );

      this.logger.log(
        `Proposal ${proposal.id}: distribution ${result.distributionId} ${result.reconciled ? 'reconciled from chain' : 'opened'} — ` +
          `asset=${result.asset} netPot=${result.netPot} claims close at ${new Date(Number(result.deadline) * 1000).toISOString()}`
      );
      return true;
    } catch (err) {
      // Cannot run as voted (not enough funds left): the caller rejects it instead of retrying.
      if (err instanceof ProposalConditionsChangedError) throw err;
      const message = (err as Error).message;
      this.logger.error(`Proposal ${proposal.id}: openDistribution failed — ${message}`);

      await this.proposalRepository.update(
        { id: proposal.id },
        {
          metadata: {
            ...proposal.metadata,
            executionError: {
              message,
              timestamp: new Date().toISOString(),
              errorCode: 'EVM_DISTRIBUTION_FAILED',
              userFriendlyMessage:
                'The distribution could not be opened on-chain. It will be retried automatically; funds have not moved.',
            },
          },
        }
      );
      return false;
    }
  }

  /**
   * Operator entry point for a distribution that failed to open. Safe to call
   * repeatedly — the on-chain execution key makes a duplicate impossible.
   *
   * Only a DISTRIBUTION proposal that passed its vote and whose execution
   * already failed may be retried. Without these checks a holder could create a
   * proposal and open the distribution immediately, skipping the vote (or open
   * a proposal the vote rejected).
   */
  async retryDistribution(proposalId: string): Promise<boolean> {
    const proposal = await this.proposalRepository.findOne({
      where: { id: proposalId },
    });
    if (!proposal) {
      throw new NotFoundException(`Proposal ${proposalId} not found`);
    }
    if (proposal.proposalType !== ProposalType.DISTRIBUTION) {
      throw new BadRequestException(`Proposal ${proposalId} is not a distribution proposal`);
    }
    if (proposal.status !== ProposalStatus.PASSED) {
      throw new BadRequestException(
        `Proposal ${proposalId} is ${proposal.status}; only PASSED proposals whose execution failed can be retried`
      );
    }
    if (!proposal.metadata?.executionError) {
      throw new BadRequestException(`Proposal ${proposalId} has no failed execution to retry`);
    }

    const vault = await this.vaultRepository.findOne({
      where: { id: proposal.vaultId },
      select: ['id', 'chain_type'],
    });
    if (vault?.chain_type !== ChainType.robinhood) {
      throw new BadRequestException(`Proposal ${proposalId} does not belong to an EVM vault`);
    }

    const success = await this.executeDistribution(proposal);
    if (!success) return false;

    // Mirror GovernanceExecutionService.executePassedProposal: the cron only
    // picks up PASSED proposals, so leaving it PASSED would re-run it.
    const fresh = await this.proposalRepository.findOne({ where: { id: proposalId } });
    const metadata = { ...(fresh?.metadata ?? proposal.metadata) };
    delete metadata.executionError;
    await this.proposalRepository.update(
      { id: proposalId, status: ProposalStatus.PASSED },
      { status: ProposalStatus.EXECUTED, executionDate: new Date(), metadata }
    );
    return true;
  }

  /**
   * Resume a termination that stalled after `beginTerminationPreparing`.
   * Safe to call repeatedly; it no-ops unless the vault is on-chain
   * `TerminationPreparing`.
   */
  async retryTermination(vaultId: string, waived?: Address[]): Promise<boolean> {
    try {
      const result = await this.terminationService.beginTermination(vaultId, {
        waived,
      });
      this.logger.log(
        `Vault ${vaultId}: beginTermination committed on retry — ${result.rows.length} asset(s), ` +
          `deadline ${result.terminationDeadline}`
      );
      return true;
    } catch (err) {
      this.logger.error(`Vault ${vaultId}: retryTermination failed — ${(err as Error).message}`);
      return false;
    }
  }
}
