import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Proposal } from './proposal.entity';

@Entity()
export class Vote {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Proposal, (proposal) => proposal.votes)
  proposal: Proposal;

  @Column()
  wallet: string;

  @Column({ type: 'varchar' })
  decision: 'APPROVE' | 'REJECT';

  @Column({ type: 'numeric' })
  amount: number;

  @CreateDateColumn()
  castAt: Date;

  @UpdateDateColumn()
  confirmedAt: Date;
}
