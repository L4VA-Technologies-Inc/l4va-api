import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AssetsModule } from '../assets/assets.module';

import { BlockchainController } from './blockchain.controller';
import { VaultContributionService } from './cardano/cardano-contribution.service';
import { BlockchainService } from './cardano/cardano-tx.service';
import { VaultManagingService } from './cardano/cardano-vault-builder.service';
import { BlockchainWebhookService } from './cardano/cardano-webhook.service';
import { MetadataRegistryApiService } from './cardano/token-metadata-registry.service';
import { EvmAirdropOrchestrator } from './evm/allocation/airdrop-orchestrator.service';
import { EvmAllocationService } from './evm/allocation/allocation.service';
import { EvmContributionCapsService } from './evm/contribution/contribution-caps.service';
import { EvmVaultContributionService } from './evm/contribution/vault-contribution.service';
import { EvmCycleCloseService } from './evm/cycle/cycle-close.service';
import { EvmLockTimePricingService } from './evm/cycle/lock-time-pricing.service';
import { EvmOpenCycleService } from './evm/cycle/open-cycle.service';
import { EvmPauseService } from './evm/cycle/pause.service';
import { EvmContributionBackfillService } from './evm/indexing/contribution-backfill.service';
import { EvmProtocolVersionBackfillService } from './evm/indexing/protocol-version-backfill.service';
import { EvmVaultEventIndexerService } from './evm/indexing/vault-event-indexer.service';
import { EvmVaultEventReconciler } from './evm/indexing/vault-event-reconciler.service';
import { EvmWebhookService } from './evm/indexing/webhook.service';
import { EvmLiquidityController } from './evm/liquidity/liquidity.controller';
import { EvmLiquidityService } from './evm/liquidity/liquidity.service';
import { EvmMarketStatsService } from './evm/liquidity/market-stats.service';
import { EvmPositionService } from './evm/liquidity/position.service';
import { EvmSwapService } from './evm/liquidity/swap.service';
import { UniswapQuoteService } from './evm/liquidity/uniswap-quote.service';
import { EvmAdapterRegistryService } from './evm/protocol/adapter-registry.service';
import { EvmContractReader } from './evm/protocol/contract-reader.service';
import { EvmFeeWithdrawService } from './evm/protocol/fee-withdraw.service';
import { EvmProtocolFeeSyncService } from './evm/protocol/protocol-fee-sync.service';
import { EvmAdminGasMonitorService } from './evm/signers/admin-gas-monitor.service';
import { EvmAdminSigner } from './evm/signers/admin-signer.service';
import { EvmKmsSigners } from './evm/signers/kms-signers.service';
import { EvmVaultSignerService } from './evm/signers/vault-signer.service';
import { EvmRefundOrchestrator } from './evm/termination/refund-orchestrator.service';
import { EvmRescueService } from './evm/termination/rescue.service';
import { EvmTerminationPreflightService } from './evm/termination/termination-preflight.service';
import { EvmTerminationService } from './evm/termination/termination.service';
import { TransactionHealthService } from './transactions/transaction-health.service';
import { TransactionsModule } from './transactions/transactions.module';

import { Asset } from '@/database/asset.entity';
import { AssetsWhitelistEntity } from '@/database/assetsWhitelist.entity';
import { Claim } from '@/database/claim.entity';
import { EvmAllocation } from '@/database/evm-allocation.entity';
import { EvmContributionValuation } from '@/database/evm-contribution-valuation.entity';
import { EvmContribution } from '@/database/evm-contribution.entity';
import { EvmExternalPosition } from '@/database/evm-external-position.entity';
import { EvmIndexRebalance } from '@/database/evm-index-rebalance.entity';
import { EvmValuationSnapshot } from '@/database/evm-valuation-snapshot.entity';
import { EvmAssetPriceFeedEntity } from '@/database/evmAssetPriceFeed.entity';
import { Market } from '@/database/market.entity';
import { Proposal } from '@/database/proposal.entity';
import { TokenRegistry } from '@/database/tokenRegistry.entity';
import { Transaction } from '@/database/transaction.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { AlertsModule } from '@/modules/alerts/alerts.module';
import { RewardsModule } from '@/modules/rewards/rewards.module';
import { EvmGovernanceFeeService } from '@/modules/vaults/phase-management/governance/evm-governance-fee.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: process.env.ENV_FILE || '.env',
    }),
    HttpModule,
    AlertsModule,
    TransactionsModule,
    AssetsModule,
    RewardsModule,
    TypeOrmModule.forFeature([
      Vault,
      Transaction,
      AssetsWhitelistEntity,
      TokenRegistry,
      Asset,
      Claim,
      User,
      Proposal,
      EvmContribution,
      EvmValuationSnapshot,
      EvmContributionValuation,
      EvmAllocation,
      EvmAssetPriceFeedEntity,
      EvmExternalPosition,
      EvmIndexRebalance,
      Market,
    ]),
  ],
  controllers: [BlockchainController, EvmLiquidityController],
  providers: [
    EvmProtocolVersionBackfillService,
    EvmAdminGasMonitorService,
    MetadataRegistryApiService,
    BlockchainService,
    VaultContributionService,
    BlockchainWebhookService,
    EvmContractReader,
    EvmKmsSigners,
    EvmAdminSigner,
    EvmAllocationService,
    EvmLockTimePricingService,
    EvmCycleCloseService,
    EvmLiquidityService,
    EvmMarketStatsService,
    EvmAirdropOrchestrator,
    EvmRefundOrchestrator,
    EvmVaultSignerService,
    EvmVaultContributionService,
    EvmContributionCapsService,
    EvmVaultEventReconciler,
    EvmVaultEventIndexerService,
    EvmContributionBackfillService,
    EvmWebhookService,
    EvmOpenCycleService,
    EvmFeeWithdrawService,
    // Owned here so EVM contribution prepare can verify protocol-fee payments;
    // GovernanceModule gets it through its BlockchainModule import.
    EvmGovernanceFeeService,
    EvmProtocolFeeSyncService,
    EvmPositionService,
    EvmSwapService,
    EvmTerminationPreflightService,
    EvmTerminationService,
    EvmAdapterRegistryService,
    EvmPauseService,
    EvmRescueService,
    UniswapQuoteService,
    VaultManagingService,
    TransactionHealthService,
  ],
  exports: [
    BlockchainService,
    VaultContributionService,
    BlockchainWebhookService,
    VaultManagingService,
    MetadataRegistryApiService,
    TransactionHealthService,
    EvmContractReader,
    EvmKmsSigners,
    EvmAdminSigner,
    EvmAllocationService,
    EvmLockTimePricingService,
    EvmCycleCloseService,
    EvmLiquidityService,
    EvmAirdropOrchestrator,
    EvmRefundOrchestrator,
    EvmContributionBackfillService,
    EvmContributionCapsService,
    EvmOpenCycleService,
    EvmFeeWithdrawService,
    EvmGovernanceFeeService,
    EvmPositionService,
    EvmSwapService,
    EvmTerminationPreflightService,
    EvmTerminationService,
    EvmAdapterRegistryService,
    EvmPauseService,
    EvmRescueService,
    UniswapQuoteService,
  ],
})
export class BlockchainModule {}
