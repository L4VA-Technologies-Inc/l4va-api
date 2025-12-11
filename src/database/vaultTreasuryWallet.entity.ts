import { Column, CreateDateColumn, Entity, JoinColumn, OneToOne, PrimaryGeneratedColumn } from 'typeorm';

import { Vault } from './vault.entity';

@Entity('vault_treasury_wallets')
export class VaultTreasuryWallet {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @OneToOne(() => Vault, vault => vault.treasury_wallet)
  @JoinColumn({ name: 'vault_id' })
  vault: Vault;

  @Column({ unique: true })
  vault_id: string;

  @Column()
  treasury_address: string; // Bech32 address (PUBLIC)

  @Column()
  public_key_hash: string; // For transaction validation (PUBLIC)

  @Column({ type: 'bytea', nullable: true })
  encrypted_private_key: Buffer; // Encrypted blob (SENSITIVE)

  @Column({ type: 'bytea', nullable: true })
  encrypted_stake_private_key: Buffer; // Encrypted blob (SENSITIVE)

  @Column()
  encryption_key_id: string; // KMS key ID reference

  @Column({ type: 'jsonb' })
  metadata: any;

  @Column({ default: true })
  is_active: boolean;

  @CreateDateColumn()
  created_at: Date;
}
