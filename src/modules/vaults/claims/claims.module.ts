import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AutomaticCancellationService } from './automatic-cancellation.service';
import { CancellationProcessor } from './cancellation.processor';
import { ClaimsVerificationService } from './claims-verification.service';
import { ClaimsController } from './claims.controller';
import { ClaimsService } from './claims.service';
import { L4vaRewardsService } from './l4va-rewards.service';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { Snapshot } from '@/database/snapshot.entity';
import { Transaction } from '@/database/transaction.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { DistributionCalculationService } from '@/modules/distribution/distribution-calculation.service';
import { AssetsModule } from '@/modules/vaults/assets/assets.module';
import { GovernanceModule } from '@/modules/vaults/phase-management/governance/governance.module';
import { TransactionsModule } from '@/modules/vaults/processing-tx/offchain-tx/transactions.module';
import { BlockchainModule } from '@/modules/vaults/processing-tx/onchain/blockchain.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'cancellationProcessing',
      defaultJobOptions: {
        removeOnComplete: 10,
        removeOnFail: 10,
      },
    }),
    TypeOrmModule.forFeature([Claim, Transaction, Asset, User, Vault, Snapshot]),
    BlockchainModule,
    TransactionsModule,
    HttpModule,
    AssetsModule,
    GovernanceModule,
  ],
  controllers: [ClaimsController],
  providers: [
    ClaimsService,
    ClaimsVerificationService,
    L4vaRewardsService,
    AutomaticCancellationService,
    CancellationProcessor,
    DistributionCalculationService,
  ],
  exports: [ClaimsService, L4vaRewardsService],
})
export class ClaimsModule {}
