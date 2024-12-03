import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Vault } from './vault.entity';

@Entity()
export class Stake {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Vault, (vault) => vault.stakes)
  vault: Vault;

  @Column()
  wallet: string;

  @Column({ type: 'numeric' })
  amount: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: 'text', nullable: true })
  metadata: string;
}
