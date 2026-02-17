import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

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
import { TransactionsModule } from '@/modules/vaults/processing-tx/offchain-tx/transactions.module';
import { BlockchainModule } from '@/modules/vaults/processing-tx/onchain/blockchain.module';
import { TreasureWalletModule } from '@/modules/vaults/treasure/treasure-wallet.module';
import { VaultValuationService } from '@/modules/vaults/vault-valuation/vault-valuation.service';
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
  ],
  providers: [LifecycleService, VaultValuationService],
  exports: [VaultValuationService, LifecycleService],
})
export class LifecycleModule {}
