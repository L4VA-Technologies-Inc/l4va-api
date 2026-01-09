import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('markets')
export class Market {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  unit: string;

  @Column({ type: 'decimal', precision: 20, scale: 8, default: 0, name: 'circSupply' })
  circSupply: number;

  @Column({ type: 'decimal', precision: 20, scale: 8, default: 0 })
  fdv: number;

  @Column({ type: 'decimal', precision: 20, scale: 8, default: 0 })
  mcap: number;

  @Column({ type: 'decimal', precision: 20, scale: 8, default: 0 })
  price: number;

  @Column({ type: 'varchar', length: 50 })
  ticker: string;

  @Column({ type: 'decimal', precision: 20, scale: 8, default: 0, name: 'totalSupply' })
  totalSupply: number;

  @Column({ type: 'decimal', precision: 10, scale: 6, default: 0, name: '1h' })
  '1h': number;

  @Column({ type: 'decimal', precision: 10, scale: 6, default: 0, name: '24h' })
  '24h': number;

  @Column({ type: 'decimal', precision: 10, scale: 6, default: 0, name: '7d' })
  '7d': number;

  @Column({ type: 'decimal', precision: 10, scale: 6, default: 0, name: '30d' })
  '30d': number;

  @Column({ type: 'varchar', length: 500, nullable: true })
  image: string;

  @Column({ type: 'decimal', precision: 20, scale: 8, default: 0 })
  tvl: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
