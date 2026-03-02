import { Module } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TransactionsModule } from '../../processing-tx/offchain-tx/transactions.module';
import { BlockchainModule } from '../../processing-tx/onchain/blockchain.module';
import { TreasureWalletModule } from '../../treasure/treasure-wallet.module';

import { DistributionService } from './distribution.service';
import { ExpansionService } from './expansion.service';
import { GovernanceExecutionService } from './governance-execution.service';
import { GovernanceFeeService } from './governance-fee.service';
import { GovernanceController } from './governance.controller';
import { GovernanceService } from './governance.service';
import { ProposalHealthService } from './proposal-health.service';
import { ProposalSchedulerService } from './proposal-scheduler.service';
import { TerminationController } from './termination.controller';
import { TerminationService } from './termination.service';
import { VoteCountingService } from './vote-counting.service';

import { Asset } from '@/database/asset.entity';
import { AssetsWhitelistEntity } from '@/database/assetsWhitelist.entity';
import { Claim } from '@/database/claim.entity';
import { Proposal } from '@/database/proposal.entity';
import { Snapshot } from '@/database/snapshot.entity';
import { Transaction } from '@/database/transaction.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { VaultTreasuryWallet } from '@/database/vaultTreasuryWallet.entity';
import { Vote } from '@/database/vote.entity';
import { AlertsModule } from '@/modules/alerts/alerts.module';
import { DexHunterModule } from '@/modules/dexhunter/dexhunter.module';
import { DistributionCalculationModule } from '@/modules/distribution/distribution-calculation.module';
import { RedisModule } from '@/modules/redis/redis.module';
import { AssetsModule } from '@/modules/vaults/assets/assets.module';
import { VyfiModule } from '@/modules/vyfi/vyfi.module';
import { WayUpModule } from '@/modules/wayup/wayup.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Vault,
      Asset,
      Snapshot,
      Proposal,
      Vote,
      Claim,
      User,
      Transaction,
      VaultTreasuryWallet,
      AssetsWhitelistEntity,
    ]),
    RedisModule,
    AssetsModule,
    WayUpModule,
    TreasureWalletModule,
    TransactionsModule,
    BlockchainModule,
    DexHunterModule,
    VyfiModule,
    AlertsModule,
    DistributionCalculationModule,
  ],
  controllers: [GovernanceController, TerminationController],
  providers: [
    GovernanceService,
    GovernanceFeeService,
    GovernanceExecutionService,
    ProposalSchedulerService,
    ExpansionService,
    VoteCountingService,
    TerminationService,
    DistributionService,
    {
      provide: ProposalHealthService,
      useFactory: (
        proposalRepository: Repository<Proposal>,
        eventEmitter: EventEmitter2,
        schedulerService: ProposalSchedulerService,
        executionService: GovernanceExecutionService
      ): ProposalHealthService => {
        return new ProposalHealthService(proposalRepository, eventEmitter, schedulerService, executionService);
      },
      inject: [getRepositoryToken(Proposal), EventEmitter2, ProposalSchedulerService, GovernanceExecutionService],
    },
  ],
  exports: [
    GovernanceService,
    GovernanceFeeService,
    GovernanceExecutionService,
    TerminationService,
    DistributionService,
    ExpansionService,
  ],
})
export class GovernanceModule {}
