import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Vault } from './vault.entity';

@Entity()
export class Asset {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Vault, (vault) => vault.assets)
  vault: Vault;

  @Column({ type: 'varchar' })
  type: 'SINGLE_NFT' | 'MULTI_NFT' | 'ANY_CNT';

  @Column()
  contractAddress: string;

  @Column({ nullable: true })
  tokenId: string;

  @Column({ type: 'numeric' })
  quantity: number;

  @Column({ type: 'numeric', nullable: true })
  floorPrice: number;

  @Column({ type: 'numeric', nullable: true })
  dexPrice: number;

  @CreateDateColumn()
  addedAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: 'text', nullable: true })
  metadata: string;
}
