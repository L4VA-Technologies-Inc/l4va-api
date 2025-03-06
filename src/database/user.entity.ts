import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  BeforeInsert, BeforeUpdate
} from 'typeorm';
import {Vault} from "./vault.entity";

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

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  created_at: string;

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
