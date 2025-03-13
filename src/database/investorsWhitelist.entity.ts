import {
  BeforeInsert,
  BeforeUpdate,
  Column,
  Entity, JoinColumn, ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import {Vault} from './vault.entity';
import {Expose} from 'class-transformer';

@Entity({ name: 'investors_whitelist' })
export class InvestorsWhitelistEntity {

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Expose({ name: 'walletAddress'})
  @Column({ type: 'varchar', nullable: false })
  wallet_address: string;

  @ManyToOne(() => Vault, (vault: Vault) => vault.investors_whitelist, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'vault_id' })
  public vault: Vault;

  @Expose({ name: 'updatedAt'})
  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  updated_at: string;

  @Expose({ name: 'createdAt'})
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
