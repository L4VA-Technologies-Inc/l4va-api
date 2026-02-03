import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { VaultValuationService } from '../vault-valuation/vault-valuation.service';

import { LifecycleService } from './lifecycle.service';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { TokenRegistry } from '@/database/tokenRegistry.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { DistributionModule } from '@/modules/distribution/distribution.module';
import { MarketModule } from '@/modules/market/market.module';
import { TaptoolsModule } from '@/modules/taptools/taptools.module';
import { ClaimsModule } from '@/modules/vaults/claims/claims.module';
import { ContributionModule } from '@/modules/vaults/phase-management/contribution/contribution.module';
import { LifecycleProcessor } from '@/modules/vaults/phase-management/lifecycle/lifecycle.processor';
import { TransactionsModule } from '@/modules/vaults/processing-tx/offchain-tx/transactions.module';
import { BlockchainModule } from '@/modules/vaults/processing-tx/onchain/blockchain.module';
import { TreasureWalletModule } from '@/modules/vaults/treasure/treasure-wallet.module';
import { VyfiModule } from '@/modules/vyfi/vyfi.module';

@Module({
  imports: [
    ContributionModule,
    DistributionModule,
    TransactionsModule,
    TreasureWalletModule,
    ClaimsModule,
    TaptoolsModule,
    MarketModule,
    VyfiModule,
    TypeOrmModule.forFeature([Vault, Asset, Claim, Transaction, TokenRegistry]),
    ScheduleModule.forRoot(),
    BlockchainModule,
    BullModule.registerQueue({
      name: 'phaseTransition',
    }),
  ],
  providers: [LifecycleService, LifecycleProcessor, VaultValuationService],
  exports: [VaultValuationService],
})
export class LifecycleModule {}
