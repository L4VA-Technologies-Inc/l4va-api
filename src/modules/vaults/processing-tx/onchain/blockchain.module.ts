import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AssetsModule } from '../../assets/assets.module';
import { TransactionHealthService } from '../offchain-tx/transaction-health.service';
import { TransactionsModule } from '../offchain-tx/transactions.module';

import { BlockchainWebhookService } from './blockchain-webhook.service';
import { BlockchainController } from './blockchain.controller';
import { BlockchainService } from './blockchain.service';
import { EvmAdapterRegistryService } from './evm-adapter-registry.service';
import { EvmAdminGasMonitorService } from './evm-admin-gas-monitor.service';
import { EvmAdminSigner } from './evm-admin-signer.service';
import { EvmAirdropOrchestrator } from './evm-airdrop-orchestrator.service';
import { EvmAllocationService } from './evm-allocation.service';
import { EvmContractReader } from './evm-contract-reader.service';
import { EvmContributionBackfillService } from './evm-contribution-backfill.service';
import { EvmContributionCapsService } from './evm-contribution-caps.service';
import { EvmCycleCloseService } from './evm-cycle-close.service';
import { EvmFeeWithdrawService } from './evm-fee-withdraw.service';
import { EvmKmsSigners } from './evm-kms-signers.service';
import { EvmLiquidityController } from './evm-liquidity.controller';
import { EvmLiquidityService } from './evm-liquidity.service';
import { EvmLockTimePricingService } from './evm-lock-time-pricing.service';
import { EvmMarketStatsService } from './evm-market-stats.service';
import { EvmOpenCycleService } from './evm-open-cycle.service';
import { EvmPauseService } from './evm-pause.service';
import { EvmPositionService } from './evm-position.service';
import { EvmProtocolFeeSyncService } from './evm-protocol-fee-sync.service';
import { EvmProtocolVersionBackfillService } from './evm-protocol-version-backfill.service';
import { EvmRefundOrchestrator } from './evm-refund-orchestrator.service';
import { EvmRescueService } from './evm-rescue.service';
import { EvmSwapService } from './evm-swap.service';
import { EvmTerminationPreflightService } from './evm-termination-preflight.service';
import { EvmTerminationService } from './evm-termination.service';
import { EvmVaultContributionService } from './evm-vault-contribution.service';
import { EvmVaultEventIndexerService } from './evm-vault-event-indexer.service';
import { EvmVaultEventReconciler } from './evm-vault-event-reconciler.service';
import { EvmVaultSignerService } from './evm-vault-signer.service';
import { EvmWebhookService } from './evm-webhook.service';
import { MetadataRegistryApiService } from './metadata-register.service';
import { UniswapQuoteService } from './uniswap-quote.service';
import { VaultContributionService } from './vault-contribution.service';
import { VaultManagingService } from './vault-managing.service';

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
