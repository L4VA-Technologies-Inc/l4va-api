// src/database/token-registry-pr.entity.ts
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { TokenRegistryPRStatus } from '../types/tokenRegistry.entity';

import { Vault } from './vault.entity';

@Entity('token_registry')
export class TokenRegistryPR {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: false })
  pr_number: number;

  @Column({
    type: 'enum',
    enum: TokenRegistryPRStatus,
    default: TokenRegistryPRStatus.PENDING,
  })
  status: TokenRegistryPRStatus;

  @ManyToOne(() => Vault, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'vault_id' })
  vault: Vault;

  @Column({ type: 'uuid' })
  vault_id: string;

  @Column({ nullable: true, type: 'timestamptz' })
  last_checked: Date;

  @Column({ nullable: true, type: 'timestamptz' })
  merged_at: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
