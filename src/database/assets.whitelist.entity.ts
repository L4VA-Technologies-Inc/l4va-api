import {
  BeforeInsert,
  BeforeUpdate,
  Column,
  Entity, ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import {Vault} from "./vault.entity";

@Entity({ name: 'assets_whitelist' })
export class AssetsWhitelistEntity {

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: false })
  asset_id: string;

  @ManyToOne(() => Vault, (vault: Vault) => vault.id)
  public vault: Vault;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  updated_at: string;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  created_at: string;

  @BeforeInsert()
  setDate() {
    this.created_at = new Date().toISOString();
  }

  @BeforeUpdate()
  updateDate() {
    this.updated_at = new Date().toISOString();
  }
}
