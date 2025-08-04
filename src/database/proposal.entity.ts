import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, OneToMany, CreateDateColumn, JoinColumn } from 'typeorm';

import { ProposalStatus, ProposalType } from '../types/proposal.types';

import { User } from './user.entity';
import { Vault } from './vault.entity';
import { Vote } from './vote.entity';

@Entity()
export class Proposal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  title: string;

  @Column('text')
  description: string;

  @Column({
    name: 'status',
    type: 'enum',
    nullable: false,
    enum: ProposalStatus,
  })
  status: ProposalStatus;

  @Column({
    name: 'proposal_type',
    type: 'enum',
    nullable: false,
    enum: ProposalType,
  })
  proposalType: ProposalType;

  @Column({ nullable: true })
  ipfsHash: string;

  @Column({ nullable: true })
  externalLink: string;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ nullable: false })
  startDate: Date;

  @Column({ nullable: true })
  endDate: Date;

  @Column({ nullable: true })
  executionDate: Date;

  @Column({ nullable: true })
  snapshotId: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'creator_id' })
  creator: User;

  @Column({ name: 'creator_id' })
  creatorId: string;

  @ManyToOne(() => Vault, vault => vault.proposals, { eager: true })
  @JoinColumn({ name: 'vault_id' })
  vault: Vault;

  @Column({ name: 'vault_id' })
  vaultId: string;

  @OneToMany(() => Vote, vote => vote.proposal)
  votes: Vote[];
}
