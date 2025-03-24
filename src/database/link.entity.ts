import {
  BeforeInsert,
  BeforeUpdate,
  Column,
  Entity, JoinColumn, ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Vault } from './vault.entity';
import { User } from './user.entity';
import { Expose } from 'class-transformer';

@Entity({ name: 'links' })
export class LinkEntity {

  @Expose({ name: 'id'})
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Expose({ name: 'url' })
  @Column({ type: 'varchar', nullable: false })
  url: string;

  @Expose({ name: 'name' })
  @Column({ type: 'varchar', nullable: false })
  name: string;

  @Expose({ name: 'vaultId' })
  @ManyToOne(() => Vault, (vault: Vault) => vault.social_links, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'vault_id' })
  vault: Vault;

  @Expose({ name: 'userId' })
  @ManyToOne(() => User, (user: User) => user.social_links, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'user_id' })
  user: User;

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
