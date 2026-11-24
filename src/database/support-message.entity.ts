import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { SupportTicket } from './support-ticket.entity';

export enum SupportMessageAuthor {
  user = 'user',
  team = 'team',
  system = 'system',
}

@Entity('support_messages')
@Index(['ticket_id', 'created_at'])
export class SupportMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'ticket_id', type: 'uuid' })
  ticket_id: string;

  @ManyToOne(() => SupportTicket, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ticket_id' })
  ticket: SupportTicket;

  @Column({ type: 'enum', enum: SupportMessageAuthor })
  author: SupportMessageAuthor;

  /** Team member's display name for team replies; null for the user and system notes. */
  @Column({ name: 'author_name', type: 'varchar', length: 100, nullable: true })
  author_name: string | null;

  @Column({ type: 'text' })
  content: string;

  /**
   * Set for every message that exists in Discord. Unique, so a reply seen by two API instances at
   * once (blue-green deploy overlap) is stored only once.
   */
  @Index({ unique: true })
  @Column({ name: 'discord_message_id', type: 'varchar', nullable: true })
  discord_message_id: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  created_at: Date;
}
