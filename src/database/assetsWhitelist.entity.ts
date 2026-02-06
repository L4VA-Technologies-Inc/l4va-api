import { Expose } from 'class-transformer';
import { Matches } from 'class-validator';
import {
  BeforeInsert,
  BeforeUpdate,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

import { Vault } from './vault.entity';

@Entity({ name: 'assets_whitelist' })
@Unique(['vault', 'policy_id'])
export class AssetsWhitelistEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Expose({ name: 'policyId' })
  @Column({ type: 'varchar', length: 56, nullable: false })
  @Matches(/^[0-9a-fA-F]{56}$/, {
    message: 'Policy ID must be a 56-character hexadecimal string',
  })
  policy_id: string;

  @Expose({ name: 'collectionName' })
  @Column({ type: 'varchar', length: 255, nullable: true })
  collection_name?: string;

  @Expose({ name: 'countCapMin' })
  @Column({
    name: 'asset_count_cap_min',
    type: 'integer',
    nullable: true,
  })
  asset_count_cap_min?: number;

  @Expose({ name: 'countCapMax' })
  @Column({
    name: 'asset_count_cap_max',
    type: 'integer',
    nullable: true,
  })
  asset_count_cap_max?: number;

  @ManyToOne(() => Vault, (vault: Vault) => vault.assets_whitelist, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'vault_id' })
  public vault: Vault;

  @Expose({ name: 'updatedAt' })
  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  updated_at: Date;

  @Expose({ name: 'createdAt' })
  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  created_at: Date;

  @BeforeInsert()
  setDate(): void {
    const now = new Date();
    this.created_at = now;
    this.updated_at = now;
  }

  @BeforeUpdate()
  updateDate(): void {
    this.updated_at = new Date();
  }
}
