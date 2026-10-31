import { SupportMessageAuthor } from '@/database/support-message.entity';
import { SupportTicketStatus } from '@/database/support-ticket.entity';

export interface SupportMessageRes {
  id: string;
  author: SupportMessageAuthor;
  /** Team member's name on team replies; null otherwise. */
  authorName: string | null;
  content: string;
  createdAt: string;
}

export interface SupportTicketRes {
  id: string;
  number: number;
  status: SupportTicketStatus;
  createdAt: string;
  closedAt: string | null;
  messages: SupportMessageRes[];
}
