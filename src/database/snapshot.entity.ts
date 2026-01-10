import { Expose } from 'class-transformer';
import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, OneToMany, CreateDateColumn, JoinColumn } from 'typeorm';

import { Proposal } from './proposal.entity';
import { Vault } from './vault.entity';
import { Vote } from './vote.entity';

@Entity()
export class Snapshot {
  @Expose({ name: 'id' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Expose({ name: 'assetId' })
  @Column({ name: 'asset_id' })
  assetId: string;

  @Expose({ name: 'addressBalances' })
  @Column({ name: 'address_balances', type: 'jsonb' })
  addressBalances: Record<string, string>;

  @Expose({ name: 'createdAt' })
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Expose({ name: 'vault' })
  @ManyToOne(() => Vault, vault => vault.snapshots, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'vault_id' })
  vault: Vault;

  @Expose({ name: 'vaultId' })
  @Column({ name: 'vault_id' })
  vaultId: string;

  @Expose({ name: 'votes' })
  @OneToMany(() => Vote, vote => vote.snapshot)
  votes: Vote[];

  @Expose({ name: 'proposals' })
  @OneToMany(() => Proposal, proposal => proposal.snapshot)
  proposals: Proposal[];
}
