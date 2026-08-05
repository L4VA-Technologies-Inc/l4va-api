import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { type Address } from 'viem';

import { buildOperationId, encodeMockAdapterParams, EvmPositionService } from '../../processing-tx/onchain/evm-position.service';
import { EvmTerminationService } from '../../processing-tx/onchain/evm-termination.service';

import { Proposal } from '@/database/proposal.entity';
import { Vault } from '@/database/vault.entity';
import { ProposalStatus, ProposalType } from '@/types/proposal.types';

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
export class EvmGovernanceExecutionService {
  private readonly logger = new Logger(EvmGovernanceExecutionService.name);
  private readonly isTestnet: boolean;
  private readonly mockAdapterAddress: Address | null;

  constructor(
    @InjectRepository(Vault) private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Proposal) private readonly proposalRepository: Repository<Proposal>,
    private readonly positionService: EvmPositionService,
    private readonly terminationService: EvmTerminationService,
    configService: ConfigService
  ) {
    this.isTestnet = configService.get<string>('CARDANO_NETWORK') !== 'mainnet';
    const raw = configService.get<string>('EVM_MOCK_ADAPTER_ADDRESS');
    this.mockAdapterAddress = raw ? (raw as Address) : null;
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

    // Mainnet: real adapter routing per action (Sprint 4)
    this.logger.warn(`Proposal ${proposal.id}: mainnet market action not yet implemented`);
    return false;
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
        this.logger.error(
          `Proposal ${proposal.id} action[${i}]: openPosition failed — ${(err as Error).message}`
        );
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
      this.logger.error(
        `Proposal ${proposal.id}: EVM termination failed — ${(err as Error).message}`
      );
      return false;
    }
  }
}
