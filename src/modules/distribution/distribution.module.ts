import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TransactionsModule } from '../vaults/processing-tx/offchain-tx/transactions.module';

import { AutomatedDistributionService } from './automated-distribution.service';
import { AcquirerExtractionBuilder } from './builders/acquirer-extraction.builder';
import { ContributorPaymentBuilder } from './builders/contributor-payment.builder';
import { DistributionCalculationService } from './distribution-calculation.service';
import { AcquirerDistributionOrchestrator } from './orchestrators/acquirer-distribution.orchestrator';
import { ContributorDistributionOrchestrator } from './orchestrators/contributor-distribution.orchestrator';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { Transaction } from '@/database/transaction.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { AssetsModule } from '@/modules/vaults/assets/assets.module';
import { ClaimsModule } from '@/modules/vaults/claims/claims.module';
import { GovernanceModule } from '@/modules/vaults/phase-management/governance/governance.module';
import { BlockchainModule } from '@/modules/vaults/processing-tx/onchain/blockchain.module';
import { VyfiModule } from '@/modules/vyfi/vyfi.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Vault, Claim, User, Transaction, Asset]),
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    BlockchainModule,
    AssetsModule,
    GovernanceModule,
    ClaimsModule,
    VyfiModule,
    TransactionsModule,
  ],
  providers: [
    DistributionCalculationService,
    AutomatedDistributionService,
    AcquirerExtractionBuilder,
    ContributorPaymentBuilder,
    AcquirerDistributionOrchestrator,
    ContributorDistributionOrchestrator,
    {
      provide: BlockFrostAPI,
      useFactory: (configService: ConfigService) => {
        return new BlockFrostAPI({
          projectId: configService.get<string>('BLOCKFROST_API_KEY'),
        });
      },
      inject: [ConfigService],
    },
  ],
  exports: [DistributionCalculationService],
})
export class DistributionModule {}
