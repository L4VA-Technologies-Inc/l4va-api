import { Expose } from 'class-transformer';
import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, CreateDateColumn, JoinColumn } from 'typeorm';

import { Proposal } from './proposal.entity';
import { Snapshot } from './snapshot.entity';
import { User } from './user.entity';

@Entity()
export class Vote {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Expose({ name: 'proposalId' })
  @Column({ name: 'proposal_id' })
  proposalId: string;

  @Expose({ name: 'voterAddress' })
  @Column({ name: 'voter_address' })
  voterAddress: string;

  @Expose({ name: 'voteWeight' })
  @Column({ name: 'vote_weight' })
  voteWeight: string;

  @Column({ name: 'vote_option_id' })
  voteOptionId: string;

  @Expose({ name: 'timestamp' })
  @CreateDateColumn({ name: 'timestamp' })
  timestamp: Date;

  @ManyToOne(() => Proposal, proposal => proposal.votes, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'proposal_id' })
  proposal: Proposal;

  @ManyToOne(() => Snapshot, snapshot => snapshot.votes, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'snapshot_id' })
  snapshot: Snapshot;

  @Expose({ name: 'snapshotId' })
  @Column({ name: 'snapshot_id' })
  snapshotId: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'voter_id' })
  voter: User;

  @Expose({ name: 'voterId' })
  @Column({ name: 'voter_id' })
  voterId: string;
}
