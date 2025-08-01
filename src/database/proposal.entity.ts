import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, OneToMany, CreateDateColumn } from 'typeorm';

import { Vault } from './vault.entity';
import { Vote } from './vote.entity';

import { ProposalStatus } from '@/types/proposal.types';

@Entity()
export class Proposal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  vaultId: string;

  @Column()
  title: string;

  @Column('text')
  description: string;

  @Column()
  creatorId: string;

  @Column()
  snapshotId: string;

  @Column({
    name: 'status',
    type: 'enum',
    nullable: false,
    enum: ProposalStatus,
  })
  status: ProposalStatus;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ nullable: true })
  endDate: Date;

  @ManyToOne(() => Vault, vault => vault.proposals)
  vault: Vault;

  @OneToMany(() => Vote, vote => vote.proposal)
  votes: Vote[];
}
