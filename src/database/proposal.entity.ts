import { Expose } from 'class-transformer';
import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, OneToMany, CreateDateColumn, JoinColumn } from 'typeorm';

import {
  BuyingSellOptionDto,
  DistributionAssetDto,
  FungibleTokenDto,
  MarketplaceAssetDto,
  NonFungibleTokenDto,
} from '../modules/vaults/phase-management/governance/dto/create-proposal.req';
import { ProposalStatus, ProposalType } from '../types/proposal.types';

import { User } from './user.entity';
import { Vault } from './vault.entity';
import { Vote } from './vote.entity';

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
  @Column({ name: 'start_date', nullable: false, type: 'timestamptz' })
  startDate: Date;

  @Expose({ name: 'endDate' })
  @Column({ name: 'end_date', nullable: false, type: 'timestamptz' })
  endDate: Date;

  @Expose({ name: 'executionDate' })
  @Column({ name: 'execution_date', nullable: true, type: 'timestamptz' })
  executionDate?: Date;

  @Expose({ name: 'snapshotId' })
  @Column({ name: 'snapshot_id', nullable: true })
  snapshotId: string;

  @Expose({ name: 'metadata' })
  @Column({ name: 'metadata', type: 'jsonb', nullable: true })
  metadata?: {
    // Staking data
    fungibleTokens?: FungibleTokenDto[];
    nonFungibleTokens?: NonFungibleTokenDto[];

    // Buy/Sell data
    buyingSellingOptions?: BuyingSellOptionDto[];

    // Distribution data
    distributionAssets?: DistributionAssetDto[];

    // Burning data
    burnAssets?: string[];

    marketplaceActions?: MarketplaceAssetDto[];
  };

  @Expose({ name: 'terminationDate' })
  @Column({ name: 'termination_date', nullable: true, type: 'timestamptz' })
  terminationDate?: Date;

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

  @Expose({ name: 'createdAt' })
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
