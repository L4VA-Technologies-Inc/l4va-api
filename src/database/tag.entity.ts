import { Expose } from 'class-transformer';
import { Entity, PrimaryGeneratedColumn, Column, ManyToMany } from 'typeorm';

import { Vault } from './vault.entity';

@Entity('tags')
export class TagEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  name: string;

  @Expose({ name: 'vaults' })
  @ManyToMany(() => Vault, (vault: Vault) => vault.tags)
  vaults: Vault[];
}
