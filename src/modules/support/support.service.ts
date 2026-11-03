import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OpenSupportTicketReq, SendSupportMessageReq } from './dto/support-ticket.req';
import { SupportMessageRes, SupportTicketRes } from './dto/support-ticket.res';
import { CloseResult, SupportDiscordService, TeamMessageEvent } from './support-discord.service';

import { SupportMessage, SupportMessageAuthor } from '@/database/support-message.entity';
import { SupportTicket, SupportTicketStatus } from '@/database/support-ticket.entity';
import { User } from '@/database/user.entity';
import { AuthUser } from '@/modules/auth/dto/auth-user.interface';

// Per-user limits (in-memory: one API instance serves traffic at a time).
const MESSAGE_LIMITS = [
  { windowMs: 60 * 1000, max: 10 },
  { windowMs: 60 * 60 * 1000, max: 120 },
];
const TICKETS_PER_DAY = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The chat shows the latest messages; older ones stay in Discord. */
const MAX_MESSAGES_RETURNED = 300;

const shortWallet = (address: string): string =>
  address && address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;

@Injectable()
export class SupportService implements OnModuleInit {
  private readonly logger = new Logger(SupportService.name);
  private readonly messageHitsByUser = new Map<string, number[]>();

  constructor(
    @InjectRepository(SupportTicket) private readonly ticketRepository: Repository<SupportTicket>,
    @InjectRepository(SupportMessage) private readonly messageRepository: Repository<SupportMessage>,
    @InjectRepository(User) private readonly userRepository: Repository<User>,
    private readonly discord: SupportDiscordService
  ) {}

  onModuleInit(): void {
    this.discord.onTeamMessage(event => this.storeTeamMessage(event));
    this.discord.onCloseRequested((channelId, closedBy) => this.closeFromDiscord(channelId, closedBy));
    this.discord.onChannelDeleted(channelId => this.handleChannelDeleted(channelId));
  }

  /** The user's open ticket, or their most recent one, with its messages; null when they never wrote. */
  async getLatestTicket(userId: string): Promise<SupportTicketRes | null> {
    const ticket =
      (await this.ticketRepository.findOne({
        where: { user_id: userId, status: SupportTicketStatus.open },
        order: { created_at: 'DESC' },
      })) ?? (await this.ticketRepository.findOne({ where: { user_id: userId }, order: { created_at: 'DESC' } }));
    return ticket ? this.toResponse(ticket) : null;
  }

  /** Starts a chat, or adds the message to the user's open chat if there is one. */
  async openTicket(authUser: AuthUser, body: OpenSupportTicketReq): Promise<SupportTicketRes> {
    if (!this.discord.isConfigured) {
      throw new ServiceUnavailableException('Support chat is not available right now');
    }
    const userId = authUser.sub;

    const open = await this.ticketRepository.findOne({ where: { user_id: userId, status: SupportTicketStatus.open } });
    if (open) {
      return this.sendMessage(authUser, open.id, { message: body.message });
    }

    const recent = await this.ticketRepository
      .createQueryBuilder('ticket')
      .where('ticket.user_id = :userId', { userId })
      .andWhere('ticket.created_at > :since', { since: new Date(Date.now() - DAY_MS) })
      .getCount();
    if (recent >= TICKETS_PER_DAY) {
      throw new HttpException('Too many support chats today, please try again tomorrow', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.consumeMessageLimit(userId);

    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const ticket = await this.ticketRepository.save(
      this.ticketRepository.create({ user_id: userId, chain: body.chain ?? null })
    );

    try {
      const channel = await this.discord.createTicketChannel({
        number: ticket.number,
        userName: user.name || shortWallet(user.address),
        wallet: user.address,
        email: user.email,
        chain: body.chain,
        pageUrl: body.pageUrl,
      });
      await this.ticketRepository.update(ticket.id, {
        discord_channel_id: channel.channelId,
        discord_webhook_id: channel.webhookId,
        discord_webhook_token: channel.webhookToken,
      });
    } catch (error) {
      this.logger.error(`Could not create Discord channel for support ticket ${ticket.number}: ${error?.message}`);
      await this.ticketRepository.delete(ticket.id);
      throw new HttpException('Could not start the chat, please try again later', HttpStatus.BAD_GATEWAY);
    }

    return this.postUserMessage(ticket.id, user, body.message.trim());
  }

  async sendMessage(authUser: AuthUser, ticketId: string, body: SendSupportMessageReq): Promise<SupportTicketRes> {
    const ticket = await this.ticketRepository.findOne({ where: { id: ticketId, user_id: authUser.sub } });
    if (!ticket) throw new NotFoundException('Support chat not found');
    if (ticket.status !== SupportTicketStatus.open) {
      throw new BadRequestException('This support chat is closed. Start a new one to write again.');
    }
    this.consumeMessageLimit(authUser.sub);

    const user = await this.userRepository.findOne({ where: { id: authUser.sub } });
    if (!user) throw new NotFoundException('User not found');
    return this.postUserMessage(ticket.id, user, body.message.trim());
  }

  async closeByUser(authUser: AuthUser, ticketId: string): Promise<SupportTicketRes> {
    const ticket = await this.ticketRepository.findOne({ where: { id: ticketId, user_id: authUser.sub } });
    if (!ticket) throw new NotFoundException('Support chat not found');
    if (ticket.status === SupportTicketStatus.open) {
      await this.markClosed(ticket, 'You closed this chat.');
      if (ticket.discord_channel_id) {
        await this.discord
          .postNotice(ticket.discord_channel_id, 'The user closed this chat in the app.')
          .catch(error => this.logger.warn(`Close notice for ticket ${ticket.number} failed: ${error.message}`));
      }
    }
    return this.toResponse(ticket);
  }

  private async postUserMessage(ticketId: string, user: User, content: string): Promise<SupportTicketRes> {
    const ticket = await this.ticketRepository
      .createQueryBuilder('ticket')
      .addSelect(['ticket.discord_webhook_id', 'ticket.discord_webhook_token'])
      .where('ticket.id = :ticketId', { ticketId })
      .getOneOrFail();

    let discordMessageId: string;
    try {
      discordMessageId = await this.discord.postAsUser(
        ticket.discord_webhook_id,
        ticket.discord_webhook_token,
        user.name || shortWallet(user.address),
        content
      );
    } catch (error) {
      this.logger.error(`Support message to Discord failed (ticket ${ticket.number}): ${error?.message}`);
      throw new HttpException('Could not send your message, please try again', HttpStatus.BAD_GATEWAY);
    }

    await this.messageRepository.save(
      this.messageRepository.create({
        ticket_id: ticket.id,
        author: SupportMessageAuthor.user,
        content,
        discord_message_id: discordMessageId,
      })
    );
    await this.ticketRepository.update(ticket.id, { last_message_at: new Date() });
    return this.toResponse(ticket);
  }

  private async storeTeamMessage(event: TeamMessageEvent): Promise<void> {
    const ticket = await this.ticketRepository.findOne({ where: { discord_channel_id: event.channelId } });
    if (!ticket) return;

    // ON CONFLICT: two API instances can both see the same reply during a deploy.
    await this.messageRepository
      .createQueryBuilder()
      .insert()
      .values({
        ticket_id: ticket.id,
        author: SupportMessageAuthor.team,
        author_name: event.authorName.slice(0, 100),
        content: event.content,
        discord_message_id: event.messageId,
      })
      .orIgnore()
      .execute();
    await this.ticketRepository.update(ticket.id, { last_message_at: new Date() });
  }

  private async closeFromDiscord(channelId: string, closedBy: string): Promise<CloseResult> {
    const ticket = await this.ticketRepository.findOne({ where: { discord_channel_id: channelId } });
    if (!ticket) return null;
    if (ticket.status !== SupportTicketStatus.open) return 'already_closed';
    await this.markClosed(ticket, `${closedBy} from the L4VA team closed this chat.`);
    return 'closed';
  }

  private async handleChannelDeleted(channelId: string): Promise<void> {
    const ticket = await this.ticketRepository.findOne({ where: { discord_channel_id: channelId } });
    if (!ticket) return;
    if (ticket.status === SupportTicketStatus.open) {
      await this.markClosed(ticket, 'This chat was closed by the L4VA team.');
    }
    await this.ticketRepository.update(ticket.id, {
      discord_channel_id: null,
      discord_webhook_id: null,
      discord_webhook_token: null,
    });
  }

  private async markClosed(ticket: SupportTicket, notice: string): Promise<void> {
    const closedAt = new Date();
    await this.ticketRepository.update(ticket.id, { status: SupportTicketStatus.closed, closed_at: closedAt });
    await this.messageRepository.save(
      this.messageRepository.create({ ticket_id: ticket.id, author: SupportMessageAuthor.system, content: notice })
    );
    ticket.status = SupportTicketStatus.closed;
    ticket.closed_at = closedAt;
  }

  private async toResponse(ticket: SupportTicket): Promise<SupportTicketRes> {
    const fresh = await this.ticketRepository.findOneOrFail({ where: { id: ticket.id } });
    const latest = await this.messageRepository.find({
      where: { ticket_id: ticket.id },
      order: { created_at: 'DESC' },
      take: MAX_MESSAGES_RETURNED,
    });
    const messages: SupportMessageRes[] = latest.reverse().map(message => ({
      id: message.id,
      author: message.author,
      authorName: message.author === SupportMessageAuthor.team ? message.author_name : null,
      content: message.content,
      createdAt: message.created_at.toISOString(),
    }));

    return {
      id: fresh.id,
      number: fresh.number,
      status: fresh.status,
      createdAt: fresh.created_at.toISOString(),
      closedAt: fresh.closed_at?.toISOString() ?? null,
      messages,
    };
  }

  private consumeMessageLimit(userId: string): void {
    const now = Date.now();
    const longestWindow = Math.max(...MESSAGE_LIMITS.map(l => l.windowMs));
    const hits = (this.messageHitsByUser.get(userId) || []).filter(t => now - t < longestWindow);

    for (const { windowMs, max } of MESSAGE_LIMITS) {
      if (hits.filter(t => now - t < windowMs).length >= max) {
        throw new HttpException(
          'You are sending messages too fast, please wait a moment',
          HttpStatus.TOO_MANY_REQUESTS
        );
      }
    }
    hits.push(now);
    this.messageHitsByUser.set(userId, hits);

    // Keep the map from growing without bound.
    if (this.messageHitsByUser.size > 10_000) {
      for (const [key, times] of this.messageHitsByUser) {
        if (!times.some(t => now - t < longestWindow)) this.messageHitsByUser.delete(key);
      }
    }
  }
}
