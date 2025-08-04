import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, OneToMany, CreateDateColumn } from 'typeorm';

import { Vault } from './vault.entity';
import { Vote } from './vote.entity';

@Entity()
export class Snapshot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  vaultId: string;

  @Column()
  assetId: string;

  @Column({ type: 'jsonb' })
  addressBalances: Record<string, string>; // address -> amount mapping

  @CreateDateColumn()
  createdAt: Date;

  @ManyToOne(() => Vault, vault => vault.snapshots)
  vault: Vault;

  @OneToMany(() => Vote, vote => vote.snapshot)
  votes: Vote[];
}
