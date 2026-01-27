import { Module } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TransactionsModule } from '../../processing-tx/offchain-tx/transactions.module';
import { BlockchainModule } from '../../processing-tx/onchain/blockchain.module';
import { TreasureWalletModule } from '../../treasure/treasure-wallet.module';

import { DistributionService } from './distribution.service';
import { GovernanceExecutionService } from './governance-execution.service';
import { GovernanceController } from './governance.controller';
import { GovernanceService } from './governance.service';
import { ProposalHealthService } from './proposal-health.service';
import { ProposalSchedulerService } from './proposal-scheduler.service';
import { TerminationController } from './termination.controller';
import { TerminationService } from './termination.service';
import { VoteCountingService } from './vote-counting.service';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { Proposal } from '@/database/proposal.entity';
import { Snapshot } from '@/database/snapshot.entity';
import { Transaction } from '@/database/transaction.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { VaultTreasuryWallet } from '@/database/vaultTreasuryWallet.entity';
import { Vote } from '@/database/vote.entity';
import { RedisModule } from '@/modules/redis/redis.module';
import { AssetsModule } from '@/modules/vaults/assets/assets.module';
import { VyfiModule } from '@/modules/vyfi/vyfi.module';
import { WayUpModule } from '@/modules/wayup/wayup.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Vault, Asset, Snapshot, Proposal, Vote, Claim, User, Transaction, VaultTreasuryWallet]),
    RedisModule,
    AssetsModule,
    WayUpModule,
    TreasureWalletModule,
    TransactionsModule,
    BlockchainModule,
    VyfiModule,
  ],
  controllers: [GovernanceController, TerminationController],
  providers: [
    GovernanceService,
    GovernanceExecutionService,
    ProposalSchedulerService,
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
  exports: [GovernanceService, GovernanceExecutionService, TerminationService, DistributionService],
})
export class GovernanceModule {}
