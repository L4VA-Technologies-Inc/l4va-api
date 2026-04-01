import { Entity, Column, Index, PrimaryColumn } from 'typeorm';

export enum OutboxStatus {
  PENDING = 'pending',
  PROCESSED = 'processed',
  FAILED = 'failed',
}

/**
 * Domain event outbox table for tracking reward-related events.
 * Events are published to l4va-rewards service for normalization and processing.
 */
@Entity('outbox', { schema: 'events' })
export class RewardEventOutbox {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ name: 'aggregate_id', type: 'uuid' })
  aggregate_id: string;

  @Column({ name: 'aggregate_type', type: 'varchar' })
  aggregate_type: string;

  @Column({ name: 'event_type', type: 'varchar' })
  @Index()
  event_type: string;

  @Column({ name: 'event_data', type: 'jsonb' })
  event_data: Record<string, any>;

  @Column({ name: 'idempotency_key', type: 'varchar', nullable: true, unique: true })
  idempotency_key: string;

  @Column({ type: 'enum', enum: OutboxStatus, default: OutboxStatus.PENDING })
  @Index()
  status: OutboxStatus;

  @Column({ name: 'attempt', type: 'integer', default: 0 })
  attempt: number;

  @Column({ name: 'max_attempts', type: 'integer', default: 5 })
  max_attempts: number;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  error_message: string;

  @Column({ name: 'next_retry_at', type: 'timestamptz', nullable: true })
  next_retry_at: Date;

  @Column({ name: 'created_at', type: 'timestamptz' })
  created_at: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processed_at: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', nullable: true })
  updated_at: Date;
}
