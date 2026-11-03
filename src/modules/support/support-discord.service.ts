import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Interaction,
  Message,
  NonThreadGuildBasedChannel,
  OverwriteType,
  PermissionFlagsBits,
  TextChannel,
  WebhookClient,
} from 'discord.js';

export const CLOSE_TICKET_BUTTON_ID = 'support-ticket-close';
const L4VA_GREEN = 0x00c805;
const DISCORD_MESSAGE_MAX_LENGTH = 2000;

export interface TicketChannelInfo {
  number: number;
  userName: string;
  wallet: string;
  email?: string | null;
  chain?: string | null;
  pageUrl?: string | null;
}

export interface CreatedTicketChannel {
  channelId: string;
  webhookId: string;
  webhookToken: string;
}

export interface TeamMessageEvent {
  channelId: string;
  messageId: string;
  authorName: string;
  content: string;
}

type TeamMessageHandler = (event: TeamMessageEvent) => Promise<void>;
/** Resolves to whether the channel belonged to a ticket of this environment. */
/** `null`: the channel is not a ticket of this environment. */
export type CloseResult = 'closed' | 'already_closed' | null;
type CloseHandler = (channelId: string, closedBy: string) => Promise<CloseResult>;
type ChannelDeletedHandler = (channelId: string) => Promise<void>;

const closeButtonRow = (disabled: boolean): ActionRowBuilder<ButtonBuilder> =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(CLOSE_TICKET_BUTTON_ID)
      .setLabel(disabled ? 'Ticket closed' : 'Close ticket')
      .setStyle(disabled ? ButtonStyle.Secondary : ButtonStyle.Danger)
      .setDisabled(disabled)
  );

export const ticketChannelName = (number: number): string => `app-ticket-${String(number).padStart(4, '0')}`;

/**
 * The team-facing side of in-app support: one private text channel per ticket in the Support
 * category. Users' messages are posted through the channel's own webhook (so they show the user's
 * name); team replies typed in the channel arrive over the gateway.
 *
 * Several environments may share one bot. Each uses its own category, and every event is filtered
 * by that category, so an environment only ever sees its own tickets.
 */
@Injectable()
export class SupportDiscordService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SupportDiscordService.name);
  private readonly token?: string;
  private readonly guildId?: string;
  private readonly categoryId?: string;
  private readonly roleId?: string;
  /** Off for dev/staging: the role still sees test tickets but is not notified. */
  private readonly pingRole: boolean;
  private client: Client | null = null;
  private ready: Promise<void> | null = null;

  private teamMessageHandler: TeamMessageHandler | null = null;
  private closeHandler: CloseHandler | null = null;
  private channelDeletedHandler: ChannelDeletedHandler | null = null;

  constructor(configService: ConfigService) {
    this.token = configService.get<string>('DISCORD_SUPPORT_BOT_TOKEN');
    this.guildId = configService.get<string>('DISCORD_GUILD_ID');
    this.categoryId = configService.get<string>('DISCORD_SUPPORT_CATEGORY_ID');
    this.roleId = configService.get<string>('DISCORD_SUPPORT_ROLE_ID');
    this.pingRole = configService.get<string>('DISCORD_SUPPORT_PING_ROLE') !== 'false';
  }

  get isConfigured(): boolean {
    return Boolean(this.token && this.guildId && this.categoryId && this.roleId);
  }

  onTeamMessage(handler: TeamMessageHandler): void {
    this.teamMessageHandler = handler;
  }

  onCloseRequested(handler: CloseHandler): void {
    this.closeHandler = handler;
  }

  onChannelDeleted(handler: ChannelDeletedHandler): void {
    this.channelDeletedHandler = handler;
  }

  async onModuleInit(): Promise<void> {
    if (!this.isConfigured) {
      this.logger.warn('Discord support bot is not configured — in-app support chat is disabled');
      return;
    }

    const client = new Client({
      // MessageContent is a privileged intent: it must be enabled for the bot in the developer portal.
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    });
    client.on(Events.MessageCreate, message => void this.handleMessage(message));
    client.on(Events.InteractionCreate, interaction => void this.handleInteraction(interaction));
    client.on(Events.ChannelDelete, channel => void this.handleChannelDelete(channel));
    client.on(Events.Error, error => this.logger.error(`Discord client error: ${error.message}`));

    this.client = client;
    this.ready = new Promise(resolve => client.once(Events.ClientReady, () => resolve()));
    // Never block API startup on Discord; requests wait for `ready` instead.
    client.login(this.token).catch(error => this.logger.error(`Discord support bot login failed: ${error.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.destroy();
  }

  /** Creates the private ticket channel, its webhook and the intro message with the close button. */
  async createTicketChannel(info: TicketChannelInfo): Promise<CreatedTicketChannel> {
    const client = await this.readyClient();
    const guild = await client.guilds.fetch(this.guildId);

    const channel = await guild.channels.create({
      name: ticketChannelName(info.number),
      type: ChannelType.GuildText,
      parent: this.categoryId,
      topic: `In-app support chat · ${info.userName} · replies here are shown to the user in the app`,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: this.roleId,
          type: OverwriteType.Role,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
          ],
        },
        {
          id: client.user.id,
          type: OverwriteType.Member,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageWebhooks,
            // The bot's server role grants nothing; everything it needs here is set on the channel.
            PermissionFlagsBits.EmbedLinks,
            ...(this.pingRole ? [PermissionFlagsBits.MentionEveryone] : []),
          ],
        },
      ],
    });

    try {
      const webhook = await channel.createWebhook({ name: 'L4VA App' });

      const embed = new EmbedBuilder()
        .setTitle(`${ticketChannelName(info.number)} — new in-app support chat`)
        .setDescription('Reply in this channel: every message here is shown to the user in the app.')
        .setColor(L4VA_GREEN)
        .addFields(
          { name: 'User', value: info.userName || '—', inline: true },
          { name: 'Chain', value: info.chain || '—', inline: true },
          { name: 'Email', value: info.email || '—', inline: true },
          { name: 'Wallet (verified)', value: `\`${info.wallet}\`` },
          ...(info.pageUrl ? [{ name: 'Page', value: info.pageUrl.slice(0, 1024) }] : [])
        )
        .setTimestamp(new Date());
      const closeRow = closeButtonRow(false);
      // Pings the support role so a new ticket is noticed.
      await channel.send({
        ...(this.pingRole ? { content: `<@&${this.roleId}>` } : {}),
        embeds: [embed],
        components: [closeRow],
        allowedMentions: { roles: this.pingRole ? [this.roleId] : [] },
      });

      return { channelId: channel.id, webhookId: webhook.id, webhookToken: webhook.token };
    } catch (error) {
      await channel.delete().catch(() => undefined);
      throw error;
    }
  }

  /** Posts a user's message into the ticket channel under their name; returns the Discord message id. */
  async postAsUser(webhookId: string, webhookToken: string, userName: string, content: string): Promise<string> {
    const webhook = new WebhookClient({ id: webhookId, token: webhookToken });
    try {
      const message = await webhook.send({
        content: content.slice(0, DISCORD_MESSAGE_MAX_LENGTH),
        username: `${userName} (app)`.slice(0, 80),
        // User text must never ping @everyone, roles or members.
        allowedMentions: { parse: [] },
      });
      return message.id;
    } finally {
      webhook.destroy();
    }
  }

  async postNotice(channelId: string, text: string): Promise<void> {
    const client = await this.readyClient();
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel?.isTextBased() && 'send' in channel) {
      await (channel as TextChannel).send({ content: text, allowedMentions: { parse: [] } });
    }
  }

  private async readyClient(): Promise<Client<true>> {
    if (!this.client || !this.ready) {
      throw new Error('Discord support bot is not configured');
    }
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Discord support bot is not connected')), 15_000)
    );
    await Promise.race([this.ready, timeout]);
    return this.client as Client<true>;
  }

  private isTicketChannel(channel: { parentId?: string | null } | null): boolean {
    return Boolean(channel && channel.parentId === this.categoryId);
  }

  private async handleMessage(message: Message): Promise<void> {
    // Our own webhook posts and bot messages (including this bot's notices) are not team replies.
    if (message.author.bot || message.webhookId || !message.inGuild()) return;
    if (!this.isTicketChannel(message.channel as NonThreadGuildBasedChannel)) return;

    const attachments = [...message.attachments.values()].map(attachment => attachment.url);
    const content = [message.content, ...attachments].filter(Boolean).join('\n').trim();
    if (!content || !this.teamMessageHandler) return;

    try {
      await this.teamMessageHandler({
        channelId: message.channelId,
        messageId: message.id,
        authorName: message.member?.displayName || message.author.globalName || message.author.username,
        content,
      });
    } catch (error) {
      this.logger.error(`Failed to store team reply ${message.id}: ${(error as Error).message}`);
    }
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isButton() || interaction.customId !== CLOSE_TICKET_BUTTON_ID) return;
    if (!this.isTicketChannel(interaction.channel as NonThreadGuildBasedChannel) || !this.closeHandler) return;

    const closedBy =
      (interaction.member && 'displayName' in interaction.member && interaction.member.displayName) ||
      interaction.user.globalName ||
      interaction.user.username;
    try {
      // Discord fails the click unless it is acknowledged within 3s, so acknowledge before touching the DB.
      await interaction.deferReply();
      const result = await this.closeHandler(interaction.channelId, closedBy);
      if (!result) {
        await interaction.deleteReply();
        return;
      }
      await interaction.editReply(
        result === 'closed'
          ? `Ticket closed by ${closedBy}. The user can no longer reply in the app.`
          : 'This chat was already closed. The user can no longer reply in the app.'
      );
      await interaction.message.edit({ components: [closeButtonRow(true)] }).catch(() => undefined);
    } catch (error) {
      // During a deploy two API instances receive the click; the second reply fails harmlessly.
      this.logger.warn(`Close ticket interaction: ${(error as Error).message}`);
    }
  }

  private async handleChannelDelete(channel: { id: string; parentId?: string | null }): Promise<void> {
    if (!this.isTicketChannel(channel) || !this.channelDeletedHandler) return;
    try {
      await this.channelDeletedHandler(channel.id);
    } catch (error) {
      this.logger.error(`Failed to close ticket for deleted channel ${channel.id}: ${(error as Error).message}`);
    }
  }
}
