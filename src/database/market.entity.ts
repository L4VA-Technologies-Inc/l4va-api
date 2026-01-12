import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Vault } from './vault.entity';

@Entity('markets')
export class Market {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Vault, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'vault_id' })
  vault: Vault;

  @Column({ type: 'uuid' })
  vault_id: string;

  @Column({ type: 'decimal', precision: 20, scale: 8, default: 0, name: 'circSupply' })
  circSupply: number;

  @Column({ type: 'decimal', precision: 20, scale: 8, default: 0 })
  mcap: number;

  @Column({ type: 'decimal', precision: 20, scale: 8, default: 0, name: 'totalSupply' })
  totalSupply: number;

  @Column({ type: 'decimal', precision: 10, scale: 6, default: 0, name: '1h' })
  '1h': number;

  @Column({ type: 'decimal', precision: 10, scale: 6, default: 0, name: '24h' })
  '24h': number;

  @Column({ type: 'decimal', precision: 10, scale: 6, default: 0, name: '7d' })
  '7d': number;

  @Column({ type: 'decimal', precision: 10, scale: 6, default: 0, name: '30d' })
  '30d': number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
