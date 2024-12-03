import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';

import { Vault } from './vault.entity';
import { Vote } from './vote.entity';

@Entity()
export class Proposal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Vault, (vault) => vault.proposals)
  vault: Vault;

  @Column({ type: 'varchar' })
  type: 'ASSET_SALE' | 'BUY' | 'STAKE' | 'LIQUIDATE';

  @OneToMany(() => Vote, (vote) => vote.proposal)
  votes: Vote[];

  @Column({ type: 'numeric', nullable: true })
  quorum: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: 'text', nullable: true })
  metadata: string;
}
