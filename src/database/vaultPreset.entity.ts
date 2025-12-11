import { Expose } from 'class-transformer';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { VaultPresetType } from '../types/vault.types';

@Entity('vault_preset')
export class VaultPreset {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({
    name: 'type',
    type: 'enum',
    enum: VaultPresetType,
    default: VaultPresetType.simple,
  })
  type: VaultPresetType;

  @Column({ type: 'uuid', nullable: true })
  user_id: string;

  @Column({ type: 'jsonb', nullable: true })
  config: Record<string, any>;

  @Expose({ name: 'created_at' })
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  created_at: Date;

  @Expose({ name: 'updated_at' })
  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  updated_at: Date;
}
