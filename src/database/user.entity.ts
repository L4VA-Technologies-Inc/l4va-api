import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToMany,
  BeforeInsert, BeforeUpdate, JoinColumn
} from 'typeorm';
import {Vault} from './vault.entity';
import {Expose} from 'class-transformer';

@Entity('users')
export class User {

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @OneToMany(() => Vault, (vault: Vault) => vault.owner)
  public vaults: Vault[];

  @Column()
  name: string;

  @Column({ unique: true })
  address: string;

  @Expose({ name: 'createdAt'})
  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  created_at: string;

  @Expose({ name: 'updatedAt'})
  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  updated_at: string;

  @BeforeInsert()
  setDate() {
    this.created_at = new Date().toISOString();
  }

  @BeforeUpdate()
  updateDate() {
    this.updated_at = new Date().toISOString();
  }

}
