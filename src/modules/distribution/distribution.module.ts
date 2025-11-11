import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AutomatedDistributionService } from './automated-distribution.service';
import { DistributionService } from './distribution.service';

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
  ],
  providers: [DistributionService, AutomatedDistributionService],
  exports: [DistributionService, AutomatedDistributionService],
})
export class DistributionModule {}
