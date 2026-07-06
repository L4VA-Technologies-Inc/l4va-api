import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';

/**
 * Cache for Anvil API responses to reduce API load and handle rate limits
 */
@Entity('anvil_api_cache')
@Index(['endpoint', 'request_payload'])
@Index(['expires_at'])
export class AnvilApiCache {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  endpoint: string;

  @Column({ type: 'jsonb', nullable: true })
  request_payload: any;

  @Column({ type: 'jsonb' })
  response_data: any;

  @Column({
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  created_at: Date;

  @Column({ type: 'timestamptz' })
  expires_at: Date;
}
