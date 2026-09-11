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

  /**
   * EVM only: the chain block this snapshot's balances correspond to.
   *
   * `created_at` is a database write time and says nothing about chain state.
   * A pro-rata distribution pays against `VaultToken.balanceOfAt(timepoint)`,
   * so without a chain timepoint recorded here the weights the vote was
   * counted on and the weights the money follows can silently diverge.
   *
   * Null on Cardano snapshots, which have no EVM timepoint.
   */
  @Expose({ name: 'snapshotBlock' })
  @Column({ name: 'snapshot_block', type: 'bigint', nullable: true })
  snapshotBlock: string | null;

  /**
   * EVM only: `block.timestamp` of `snapshot_block`. This is the value passed
   * to `openDistribution` as the timepoint, because VaultToken's clock is
   * timestamp-based (ERC-6372 `mode=timestamp`), not block-based.
   */
  @Expose({ name: 'snapshotTimepoint' })
  @Column({ name: 'snapshot_timepoint', type: 'bigint', nullable: true })
  snapshotTimepoint: string | null;

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
