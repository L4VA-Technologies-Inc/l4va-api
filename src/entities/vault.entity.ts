import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToMany,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Asset } from './asset.entity';
import { Proposal } from './proposal.entity';
import { Stake } from './stake.entity';

@Entity()
export class Vault {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  contractAddress: string;

  @Column({ type: 'varchar' })
  type: 'PRIVATE' | 'PUBLIC' | 'SEMI_PRIVATE';

  @Column({ type: 'varchar' })
  status: 'DRAFT' | 'ACTIVE' | 'LOCKED' | 'TERMINATED';

  @OneToMany(() => Asset, (asset) => asset.vault)
  assets: Asset[];

  @OneToMany(() => Proposal, (proposal) => proposal.vault)
  proposals: Proposal[];

  @OneToMany(() => Stake, (stake) => stake.vault)
  stakes: Stake[];

  @Column({ type: 'varchar', nullable: true })
  fractionalizationTokenAddress: string;

  @Column({ type: 'numeric', nullable: true })
  fractionalizationPercentage: number;

  @Column({ type: 'integer', nullable: true })
  tokenSupply: number;

  @Column({ type: 'integer', nullable: true })
  tokenDecimals: number;

  @Column({ type: 'text', nullable: true })
  metadata: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
