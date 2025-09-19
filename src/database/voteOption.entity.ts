import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';

import { Proposal } from './proposal.entity';

@Entity('vote_options')
export class VoteOption {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'proposal_id' })
  proposalId: string;

  @ManyToOne(() => Proposal, proposal => proposal.voteOptions)
  @JoinColumn({ name: 'proposal_id' })
  proposal: Proposal;

  @Column()
  label: string;

  @Column({ default: 0 })
  order: number;
}
