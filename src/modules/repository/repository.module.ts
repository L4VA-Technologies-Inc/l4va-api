import { TypeOrmModule } from '@nestjs/typeorm';
import { Module } from '@nestjs/common';
import { Proposal } from '../../entities/proposal.entity';
import { Vault } from '../../entities/vault.entity';
import { Asset } from '../../entities/asset.entity';
import { Stake } from '../../entities/stake.entity';
import { Vote } from '../../entities/vote.entity';
import { AssetRepository } from './asset.repository';
import { ProposalRepository } from './proposal.repository';
import { StakeRepository } from './stake.repository';
import { VaultRepository } from './vault.repository';
import { VoteRepository } from './vote.repository';

const repositories = [
  AssetRepository,
  ProposalRepository,
  StakeRepository,
  VaultRepository,
  VoteRepository,
];

@Module({
  imports: [TypeOrmModule.forFeature([
    Asset,
    Proposal,
    Stake,
    Vault,
    Vote
  ])],
  providers: [...repositories],
  exports: [...repositories],
})
export class RepositoryModule {}
