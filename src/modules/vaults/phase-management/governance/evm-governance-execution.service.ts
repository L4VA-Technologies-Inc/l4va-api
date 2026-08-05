import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { type Address } from 'viem';

import { EvmAdapterRegistryService } from '../../processing-tx/onchain/evm-adapter-registry.service';
import {
  buildOperationId,
  encodeMockAdapterParams,
  EvmPositionService,
  type ClosePositionParams,
} from '../../processing-tx/onchain/evm-position.service';
import { EvmTerminationService } from '../../processing-tx/onchain/evm-termination.service';
import { UniswapQuoteService } from '../../processing-tx/onchain/uniswap-quote.service';

import { Proposal } from '@/database/proposal.entity';
import { Vault } from '@/database/vault.entity';
import { ProposalType } from '@/types/proposal.types';

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
  private readonly isTestnet: boolean;
  private readonly mockAdapterAddress: Address | null;
  private readonly uniswapAdapterAddress: Address | null;
  /** Default swap slippage in basis points (0.5%). Configurable via EVM_SWAP_SLIPPAGE_BPS. */
  private readonly swapSlippageBps: number;

  constructor(
    @InjectRepository(Vault) private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Proposal) private readonly proposalRepository: Repository<Proposal>,
    private readonly positionService: EvmPositionService,
    private readonly terminationService: EvmTerminationService,
    private readonly adapterRegistryService: EvmAdapterRegistryService,
    private readonly uniswapQuoteService: UniswapQuoteService,
    configService: ConfigService
  ) {
    this.isTestnet = configService.get<string>('CARDANO_NETWORK') !== 'mainnet';
    const raw = configService.get<string>('EVM_MOCK_ADAPTER_ADDRESS');
    this.mockAdapterAddress = raw ? (raw as Address) : null;
    const uniswapRaw = configService.get<string>('EVM_UNISWAP_ADAPTER_ADDRESS');
    this.uniswapAdapterAddress = uniswapRaw ? (uniswapRaw as Address) : null;
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
      } else {
        this.logger.debug(`MockAdapter ${this.mockAdapterAddress} already approved — no-op`);
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
  async executeProposal(proposal: Proposal, vault: Vault): Promise<boolean> {
    switch (proposal.proposalType) {
      case ProposalType.MARKETPLACE_ACTION:
      case ProposalType.BUY_SELL:
        return this.executeMarketAction(proposal, vault);

      case ProposalType.STAKING:
        return this.executeStakingAction(proposal, vault);

      case ProposalType.TERMINATION:
        return this.executeTermination(proposal, vault);

      case ProposalType.DISTRIBUTION:
        // Distributions are already handled by the airdrop orchestrator
        // (closeCycle → claimAllocations). Mark as executed immediately.
        this.logger.log(`Proposal ${proposal.id}: DISTRIBUTION — delegated to airdrop pipeline, marking executed`);
        return true;

      case ProposalType.BURNING:
        // No VT burn governance equivalent on EVM yet.
        this.logger.warn(`Proposal ${proposal.id}: BURNING not supported on EVM — skipping`);
        return false;

      case ProposalType.EXPANSION:
      case ProposalType.ACQUIRE_EXPANSION:
        // Expansion on EVM is handled via openCycle flow, not proposals.
        this.logger.warn(`Proposal ${proposal.id}: ${proposal.proposalType} not executed via governance on EVM`);
        return false;

      default:
        this.logger.warn(`Proposal ${proposal.id}: unknown type ${proposal.proposalType} for EVM execution`);
        return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Market actions → openPosition via adapter
  // ---------------------------------------------------------------------------

  private async executeMarketAction(proposal: Proposal, vault: Vault): Promise<boolean> {
    const actions = proposal.metadata?.marketplaceActions ?? [];
    if (actions.length === 0) {
      this.logger.warn(`Proposal ${proposal.id}: no marketplaceActions in metadata`);
      return false;
    }

    if (this.isTestnet) {
      return this.executeMarketActionMock(proposal, vault, actions);
    }

    return this.executeMarketActionUniswap(proposal, vault, actions);
  }

  private async executeMarketActionUniswap(proposal: Proposal, vault: Vault, actions: any[]): Promise<boolean> {
    if (!this.uniswapAdapterAddress) {
      this.logger.error(
        `EVM_UNISWAP_ADAPTER_ADDRESS is not configured — cannot execute mainnet market proposal ${proposal.id}`
      );
      return false;
    }

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];

      // CLOSE_POSITION: unwind an existing adapter position.
      if (action.exec === 'CLOSE_POSITION') {
        const ok = await this.executeClosePosition(proposal, vault, action, i);
        if (!ok) return false;
        continue;
      }

      // Default: open a new Uniswap swap position.
      const tokenIn: Address = action.inputAsset ?? action.policyId ?? '0x0000000000000000000000000000000000000000';
      const tokenOut: Address =
        action.expectedOutputAsset ?? action.outputAsset ?? '0x0000000000000000000000000000000000000000';
      const inputAmountRaw = BigInt(action.amount ?? action.quantity ?? 0);

      if (inputAmountRaw === 0n || tokenIn === tokenOut) continue;

      try {
        const quote = await this.uniswapQuoteService.quoteExactInput(
          tokenIn,
          tokenOut,
          inputAmountRaw,
          this.swapSlippageBps
        );

        const operationId = buildOperationId(vault.id, proposal.id, i);

        await this.positionService.openPosition(vault.id, {
          operationId,
          adapter: this.uniswapAdapterAddress,
          protocol: '0xcaf681a66d020601342297493863e78c959e5cb2', // SwapRouter02 as protocol tag
          inputAsset: tokenIn,
          maxInputAmount: inputAmountRaw,
          expectedPositionAsset: tokenOut,
          minExpectedOutput: quote.minAmountOut,
          deadline: 0n,
          protocolParams: quote.protocolParams,
        });

        this.logger.log(
          `Proposal ${proposal.id} action[${i}]: Uniswap V3 swap ${tokenIn}→${tokenOut} ` +
            `fee=${quote.fee} minOut=${quote.minAmountOut} — ok`
        );
      } catch (err) {
        this.logger.error(`Proposal ${proposal.id} action[${i}]: Uniswap swap failed — ${(err as Error).message}`);
        return false;
      }
    }

    return true;
  }

  private async executeClosePosition(
    proposal: Proposal,
    vault: Vault,
    action: any,
    actionIndex: number
  ): Promise<boolean> {
    const positionId = BigInt(action.positionId ?? 0);
    if (positionId === 0n) {
      this.logger.error(`Proposal ${proposal.id} action[${actionIndex}]: CLOSE_POSITION missing positionId`);
      return false;
    }

    // positionAsset = token we hold in the position; underlyingAsset = what we swap back to.
    const positionAsset: Address = action.positionAsset ?? '0x0000000000000000000000000000000000000000';
    const underlyingAsset: Address = action.underlyingAsset ?? '0x0000000000000000000000000000000000000000';
    const positionAmount = BigInt(action.positionAmount ?? 0);

    if (positionAmount === 0n || positionAsset === underlyingAsset) {
      this.logger.error(`Proposal ${proposal.id} action[${actionIndex}]: CLOSE_POSITION invalid amounts`);
      return false;
    }

    try {
      // Quote the reverse swap to compute minUnderlyingReturned.
      const quote = await this.uniswapQuoteService.quoteExactInput(
        positionAsset,
        underlyingAsset,
        positionAmount,
        this.swapSlippageBps,
        action.feeTier
      );

      const closeParams: ClosePositionParams = {
        positionId,
        minUnderlyingReturned: quote.minAmountOut,
        deadline: 0n,
        protocolParams: quote.protocolParams,
      };

      await this.positionService.closePosition(vault.id, closeParams);

      this.logger.log(
        `Proposal ${proposal.id} action[${actionIndex}]: closePosition id=${positionId} ` +
          `${positionAsset}→${underlyingAsset} minReturn=${quote.minAmountOut} — ok`
      );
      return true;
    } catch (err) {
      this.logger.error(
        `Proposal ${proposal.id} action[${actionIndex}]: closePosition failed — ${(err as Error).message}`
      );
      return false;
    }
  }

  private async executeMarketActionMock(proposal: Proposal, vault: Vault, actions: any[]): Promise<boolean> {
    if (!this.mockAdapterAddress) {
      this.logger.error(
        `EVM_MOCK_ADAPTER_ADDRESS is not configured — cannot execute testnet market proposal ${proposal.id}`
      );
      return false;
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
          deadline: 0n,
          protocolParams,
        });

        this.logger.log(`Proposal ${proposal.id} action[${i}]: openPosition via MockAdapter — ok`);
      } catch (err) {
        this.logger.error(`Proposal ${proposal.id} action[${i}]: openPosition failed — ${(err as Error).message}`);
        return false;
      }
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Staking → openPosition via staking adapter
  // ---------------------------------------------------------------------------

  private async executeStakingAction(proposal: Proposal, vault: Vault): Promise<boolean> {
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
        all.map(t => ({ inputAsset: '0x0000000000000000000000000000000000000000', amount: (t as any).amount ?? 1 }))
      );
    }

    this.logger.warn(`Proposal ${proposal.id}: mainnet staking adapter not yet implemented`);
    return false;
  }

  // ---------------------------------------------------------------------------
  // Termination → beginTerminationPreparing → beginTermination
  // ---------------------------------------------------------------------------

  private async executeTermination(proposal: Proposal, vault: Vault): Promise<boolean> {
    try {
      // Step 1: prepare
      await this.terminationService.beginTerminationPreparing(vault.id);
      this.logger.log(`Proposal ${proposal.id}: beginTerminationPreparing submitted`);

      // Step 2: snapshot + begin
      // Distributable assets = all ERC-20s currently held (from metadata or empty list)
      const distributableAssets: Address[] = (proposal.metadata as any)?.distributableAssets ?? [];
      await this.terminationService.beginTermination(vault.id, distributableAssets);
      this.logger.log(`Proposal ${proposal.id}: beginTermination submitted — vault is now Terminating`);

      return true;
    } catch (err) {
      this.logger.error(`Proposal ${proposal.id}: EVM termination failed — ${(err as Error).message}`);
      return false;
    }
  }
}
