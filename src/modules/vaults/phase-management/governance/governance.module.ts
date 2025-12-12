import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { GovernanceExecutionService } from './governance-execution.service';
import { GovernanceController } from './governance.controller';
import { GovernanceService } from './governance.service';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { Proposal } from '@/database/proposal.entity';
import { Snapshot } from '@/database/snapshot.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { Vote } from '@/database/vote.entity';
import { WayUpModule } from '@/modules/wayup/wayup.module';

@Module({
  imports: [TypeOrmModule.forFeature([Vault, Asset, Snapshot, Proposal, Vote, Claim, User]), WayUpModule],
  controllers: [GovernanceController],
  providers: [GovernanceService, GovernanceExecutionService],
  exports: [GovernanceService, GovernanceExecutionService],
})
export class GovernanceModule {}
