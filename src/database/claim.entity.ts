import { Expose } from 'class-transformer';
import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, BeforeInsert, BeforeUpdate } from 'typeorm';

import { ClaimStatus } from '../types/claim.types';

import { User } from './user.entity';
import { Vault } from './vault.entity';

@Entity('claims')
export class Claim {
  @Expose({ name: 'id' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Expose({ name: 'userId' })
  @ManyToOne(() => User, (user: User) => user.claims, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Expose({ name: 'vaultId' })
  @ManyToOne(() => Vault, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'vault_id' })
  vault: Vault;

  @Expose({ name: 'type' })
  @Column({ type: 'varchar', nullable: false })
  type: string;

  @Expose({ name: 'status' })
  @Column({
    type: 'enum',
    enum: ClaimStatus,
    nullable: false,
    default: ClaimStatus.AVAILABLE,
  })
  status: ClaimStatus;

  @Expose({ name: 'amount' })
  @Column({ type: 'decimal', precision: 20, scale: 6, default: 0 })
  amount: number;

  @Expose({ name: 'txHash' })
  @Column({ type: 'varchar', nullable: true })
  tx_hash: string;

  @Expose({ name: 'description' })
  @Column({ type: 'text', nullable: true })
  description: string;

  @Expose({ name: 'metadata' })
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  @Expose({ name: 'createdAt' })
  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  created_at: string;

  @Expose({ name: 'updatedAt' })
  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  updated_at: string;

  @BeforeInsert()
  setDate() {
    this.created_at = new Date().toISOString();
    this.updated_at = new Date().toISOString();
  }

  @BeforeUpdate()
  updateDate() {
    this.updated_at = new Date().toISOString();
  }
}
