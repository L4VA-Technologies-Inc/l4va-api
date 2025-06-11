import { Expose } from 'class-transformer';
import { Entity, PrimaryGeneratedColumn, Column, ManyToMany, JoinTable } from 'typeorm';

import { Vault } from './vault.entity';

@Entity('tags')
export class TagEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  name: string;

  @Expose({ name: 'vaults' })
  @ManyToMany(() => Vault, (vault: Vault) => vault.tags)
  @JoinTable({
    name: 'vault_tags',
    joinColumn: {
      name: 'tag_id',
      referencedColumnName: 'id',
    },
    inverseJoinColumn: {
      name: 'vault_id',
      referencedColumnName: 'id',
    },
  })
  vaults: Vault[];
}
