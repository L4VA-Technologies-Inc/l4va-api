import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToMany,
  OneToOne,
  BeforeInsert,
  BeforeUpdate,
  JoinColumn
} from 'typeorm';
import { Vault } from './vault.entity';
import {Exclude, Expose} from 'class-transformer';
import { FileEntity } from './file.entity';
import { LinkEntity } from './link.entity';

@Entity('users')
export class User {

  @Expose({ name: 'id' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Exclude()
  @OneToMany(() => Vault, (vault: Vault) => vault.owner)
  public vaults: Vault[];

  @Expose({ name: 'name' })
  @Column()
  name: string;

  @Expose({ name: 'address' })
  @Column({ unique: true })
  address: string;

  @Expose({ name: 'description' })
  @Column({ nullable: true })
  description: string;

  @Expose({ name: 'profileImage' })
  @OneToOne(() => FileEntity)
  @JoinColumn({ name: 'profile_image_id' })
  profile_image: FileEntity;

  @Expose({ name: 'bannerImage' })
  @OneToOne(() => FileEntity)
  @JoinColumn({ name: 'banner_image_id' })
  banner_image: FileEntity;

  @Expose({ name: 'socialLinks' })
  @OneToMany(() => LinkEntity, (link: LinkEntity) => link.user)
  social_links: LinkEntity[];

  @Expose({ name: 'tvl' })
  @Column({ type: 'decimal', precision: 20, scale: 2, default: 0 })
  tvl: number;

  @Expose({ name: 'totalVaults' })
  @Column({ type: 'integer', default: 0 })
  total_vaults: number;

  @Expose({ name: 'gains' })
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  gains: number;

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
