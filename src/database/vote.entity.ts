import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, CreateDateColumn } from 'typeorm';

import { Proposal } from './proposal.entity';
import { Snapshot } from './snapshot.entity';

import { VoteType } from '@/types/vote.types';

@Entity()
export class Vote {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  proposalId: string;

  @Column()
  snapshotId: string;

  @Column()
  voterId: string;

  @Column()
  voterAddress: string;

  @Column()
  voteWeight: string;

  @Column({
    name: 'vote',
    type: 'enum',
    enum: VoteType,
    nullable: true,
  })
  vote?: VoteType;

  @CreateDateColumn()
  timestamp: Date;

  @ManyToOne(() => Proposal, proposal => proposal.votes)
  proposal: Proposal;

  @ManyToOne(() => Snapshot, snapshot => snapshot.votes)
  snapshot: Snapshot;
}
