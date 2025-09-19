import { Expose } from 'class-transformer';
import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, OneToMany, CreateDateColumn, JoinColumn } from 'typeorm';

import {
  DistributionAssetDto,
  FungibleTokenDto,
  NonFungibleTokenDto,
} from '../modules/vaults/phase-management/governance/dto/create-proposal.req';
import { ProposalStatus, ProposalType } from '../types/proposal.types';

import { User } from './user.entity';
import { Vault } from './vault.entity';
import { Vote } from './vote.entity';
import { VoteOption } from './voteOption.entity';

@Entity()
export class Proposal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Expose({ name: 'title' })
  @Column()
  title: string;

  @Expose({ name: 'description' })
  @Column('text')
  description: string;

  @Expose({ name: 'status' })
  @Column({
    name: 'status',
    type: 'enum',
    nullable: false,
    enum: ProposalStatus,
  })
  status: ProposalStatus;

  @Expose({ name: 'proposalType' })
  @Column({
    name: 'proposal_type',
    type: 'enum',
    nullable: false,
    enum: ProposalType,
  })
  proposalType: ProposalType;

  @Expose({ name: 'ipfsHash' })
  @Column({ name: 'ipfsHash', nullable: true })
  ipfsHash: string;

  @Expose({ name: 'externalLink' })
  @Column({ name: 'external_link', nullable: true })
  externalLink: string;

  @Expose({ name: 'startDate' })
  @Column({ name: 'start_date', nullable: false })
  startDate: Date;

  @Expose({ name: 'endDate' })
  @Column({ name: 'end_date', nullable: true })
  endDate: Date;

  @Expose({ name: 'executionDate' })
  @Column({ name: 'execution_date', nullable: true })
  executionDate: Date;

  @Expose({ name: 'snapshotId' })
  @Column({ name: 'snapshot_id', nullable: true })
  snapshotId: string;

  // Add direct columns for each proposal type's specific data
  @Expose({ name: 'fungibleTokens' })
  @Column({ name: 'fungible_tokens', type: 'json', nullable: true })
  fungibleTokens?: FungibleTokenDto[];

  @Expose({ name: 'nonFungibleTokens' })
  @Column({ name: 'non_fungible_tokens', type: 'json', nullable: true })
  nonFungibleTokens?: NonFungibleTokenDto[];

  @Expose({ name: 'distributionAssets' })
  @Column({ name: 'distribution_assets', type: 'json', nullable: true })
  distributionAssets?: DistributionAssetDto[];

  @Expose({ name: 'terminationReason' })
  @Column({ name: 'termination_reason', type: 'text', nullable: true })
  terminationReason?: string;

  @Expose({ name: 'terminationDate' })
  @Column({ name: 'termination_date', nullable: true })
  terminationDate?: Date;

  @Expose({ name: 'burnAssets' })
  @Column({ name: 'burn_assets', type: 'json', nullable: true })
  burnAssets?: any[];

  @Expose({ name: 'buyingSellingOptions' })
  @Column({ name: 'buying_selling_options', type: 'json', nullable: true })
  buyingSellingOptions?: any[];

  @Expose({ name: 'abstain' })
  @Column({ name: 'abstain', type: 'boolean', nullable: true, default: false })
  abstain?: boolean;

  @Expose({ name: 'creator' })
  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'creator_id' })
  creator: User;

  @Column({ name: 'creator_id' })
  creatorId: string;

  @Expose({ name: 'vault' })
  @ManyToOne(() => Vault, vault => vault.proposals, { eager: true, nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'vault_id' })
  vault: Vault;

  @Expose({ name: 'vaultId' })
  @Column({ name: 'vault_id' })
  vaultId: string;

  @Expose({ name: 'votes' })
  @OneToMany(() => Vote, vote => vote.proposal)
  votes: Vote[];

  @Expose({ name: 'voteOptions' })
  @OneToMany(() => VoteOption, voteOption => voteOption.proposal)
  voteOptions: VoteOption[];

  @Expose({ name: 'hasCustomVoteOptions' })
  @Column({ name: 'has_custom_vote_options', type: 'boolean', default: false })
  hasCustomVoteOptions: boolean;

  @Expose({ name: 'createdAt' })
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
