import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { GovernanceController } from './governance.controller';
import { GovernanceService } from './governance.service';

import { Asset } from '@/database/asset.entity';
import { Proposal } from '@/database/proposal.entity';
import { Snapshot } from '@/database/snapshot.entity';
import { Vault } from '@/database/vault.entity';
import { Vote } from '@/database/vote.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Vault, Asset, Snapshot, Proposal, Vote])],
  controllers: [GovernanceController],
  providers: [GovernanceService],
  exports: [GovernanceService],
})
export class GovernanceModule {}
