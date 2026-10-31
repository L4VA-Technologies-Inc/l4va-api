import {
  Column,
  CreateDateColumn,
  Entity,
  Generated,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User } from './user.entity';

export enum SupportTicketStatus {
  open = 'open',
  closed = 'closed',
}

/**
 * An in-app support chat. Mirrored to a private `app-ticket-NNNN` channel in the team Discord:
 * user messages are posted there through the channel's webhook, team replies come back through the bot.
 */
@Entity('support_tickets')
export class SupportTicket {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Human-facing number, shown as app-ticket-0001. */
  @Column({ type: 'integer', unique: true })
  @Generated('increment')
  number: number;

  @Index()
  @Column({ name: 'user_id', type: 'uuid' })
  user_id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'enum', enum: SupportTicketStatus, default: SupportTicketStatus.open })
  status: SupportTicketStatus;

  @Column({ type: 'varchar', length: 16, nullable: true })
  chain: string | null;

  @Index({ unique: true })
  @Column({ name: 'discord_channel_id', type: 'varchar', nullable: true })
  discord_channel_id: string | null;

  @Column({ name: 'discord_webhook_id', type: 'varchar', nullable: true, select: false })
  discord_webhook_id: string | null;

  /** Lets anyone holding it post as the webhook, so it is never selected by default. */
  @Column({ name: 'discord_webhook_token', type: 'varchar', nullable: true, select: false })
  discord_webhook_token: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  created_at: Date;

  @Column({ name: 'last_message_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  last_message_at: Date;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closed_at: Date | null;
}
