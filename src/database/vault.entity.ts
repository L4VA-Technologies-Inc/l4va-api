import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from 'typeorm';
import { User } from './user.entity';

@Entity('vaults')
export class Vault {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User)
  owner: User;

  @Column()
  ownerId: string;

  @Column()
  name: string;

  @Column({
    type: 'enum',
    enum: ['single', 'multi', 'cnt'],
  })
  type: 'single' | 'multi' | 'cnt';

  @Column({
    type: 'enum',
    enum: ['private', 'public', 'semi-private'],
  })
  privacy: 'private' | 'public' | 'semi-private';

  @Column({ nullable: true })
  brief?: string;

  @Column({ nullable: true })
  imageUrl?: string;

  @Column({ nullable: true })
  bannerUrl?: string;

  @Column('jsonb', { nullable: true })
  socialLinks: {
    facebook?: string;
    twitter?: string;
  };

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt: Date;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  updatedAt: Date;
}
