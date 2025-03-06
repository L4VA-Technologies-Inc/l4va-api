import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  BeforeInsert,
  BeforeUpdate,
  JoinColumn,
  OneToOne, OneToMany
} from 'typeorm';
import { User } from './user.entity';
import {FileEntity} from "./file.entity";
import {AssetsWhitelistEntity} from "./assets.whitelist.entity";

@Entity('vaults')
export class Vault {

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, (owner: User) => owner.id)
  public owner: User;

  @OneToMany(() => AssetsWhitelistEntity, (asset: AssetsWhitelistEntity) => asset.id)
  public assets_whitelist: AssetsWhitelistEntity[];

  @Column()
  name: string;

  @Column()
  type: string;

  @Column()
  privacy: string;

  @Column({ nullable: true })
  description?: string;

  @OneToOne(() => FileEntity)
  @JoinColumn()
  vault_image?: FileEntity;

  @OneToOne(() => FileEntity)
  @JoinColumn()
  banner_image?: FileEntity;

  @Column('jsonb', { nullable: true })
  socialLinks: {
    facebook?: string;
    twitter?: string;
  };

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
