import { Expose } from 'class-transformer';
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';

import { User } from './user.entity';

@Entity('notifications')
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: false })
  user_id: string;

  @Expose({ name: 'title' })
  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Expose({ name: 'message' })
  @Column({ type: 'text' })
  message: string;

  @Expose({ name: 'type' })
  @Column({
    type: 'varchar',
    length: 100,
    comment: 'Type of notification (e.g., vault_launch, governance_proposal, distribution_claim)',
  })
  type: string;

  @Expose({ name: 'actionUrl' })
  @Column({
    type: 'text',
    nullable: true,
    comment: 'URL to navigate to when notification is clicked',
  })
  action_url: string;

  @Expose({ name: 'isRead' })
  @Column({ type: 'boolean', default: false })
  is_read: boolean;

  @Expose({ name: 'relatedEntityType' })
  @Column({
    type: 'varchar',
    length: 50,
    nullable: true,
    comment: 'Type of related entity (vault, proposal, governance)',
  })
  related_entity_type: string;

  @Expose({ name: 'relatedEntityId' })
  @Column({
    type: 'uuid',
    nullable: true,
    comment: 'UUID of related entity (vault ID, proposal ID, etc.)',
  })
  related_entity_id: string;

  @Expose({ name: 'readAt' })
  @Column({ type: 'timestamptz', nullable: true })
  read_at: Date;

  @CreateDateColumn()
  created_at: Date;

  @ManyToOne(() => User, user => user.notifications)
  @JoinColumn({ name: 'user_id' })
  user: User;
}
