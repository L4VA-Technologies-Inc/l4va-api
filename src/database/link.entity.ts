import {
  BeforeInsert,
  BeforeUpdate,
  Column,
  Entity, ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import {Vault} from "./vault.entity";
import {Expose} from "class-transformer";

@Entity({ name: 'links' })
export class LinkEntity {

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: false })
  url: string;

  @Column({ type: 'varchar', nullable: false })
  name: string;

  @ManyToOne(() => Vault, (vault: Vault) => vault.social_links, { onDelete: 'CASCADE' })
  vault: Vault;

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
