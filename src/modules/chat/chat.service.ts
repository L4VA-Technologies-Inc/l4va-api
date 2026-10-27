import { Injectable, Logger } from '@nestjs/common';
import { APIResponse, ChannelMemberResponse, StreamChat, UserResponse } from 'stream-chat';

@Injectable()
export class ChatService {
  static readonly TOKEN_TTL_SECONDS = 60 * 60;

  private readonly logger = new Logger(ChatService.name);
  private readonly serverClient: StreamChat;

  constructor() {
    const apiKey = process.env.STREAM_API_KEY;
    const apiSecret = process.env.STREAM_API_SECRET;

    this.serverClient = StreamChat.getInstance(apiKey || 'YOUR_API_KEY', apiSecret || 'YOUR_API_SECRET');
  }

  async createVaultChatRoom(vaultId: string, createdByUserId?: string) {
    try {
      const channelData = {
        name: `Vault ${vaultId} Chat`,
        vault_id: vaultId,
        created_by_id: createdByUserId || 'system',
        members: createdByUserId ? [createdByUserId] : [],
      };

      const channel = this.serverClient.channel('messaging', `vault-${vaultId}`, channelData);

      await channel.create({
        created_by_id: createdByUserId || 'system',
      });

      if (createdByUserId) {
        try {
          await channel.addMembers([createdByUserId]);
        } catch (memberError) {
          this.logger.warn(`Could not add member ${createdByUserId}: ${memberError.message}`);
        }
      }

      return channel;
    } catch (error) {
      this.logger.error(`Failed to create vault chat room: ${error.message}`);
      throw error;
    }
  }

  generateUserToken(userId: string): string {
    const expiresAt = Math.floor(Date.now() / 1000) + ChatService.TOKEN_TTL_SECONDS;
    return this.serverClient.createToken(userId, expiresAt);
  }

  async createOrUpdateUser(
    userId: string,
    userData: { name?: string; image?: string }
  ): Promise<
    APIResponse & {
      users: {
        [key: string]: UserResponse;
      };
    }
  > {
    const name = userData.name || `User ${userId}`;
    const user = {
      id: userId,
      name,
      image: userData.image || `https://getstream.io/random_png/?id=${userId}&name=${encodeURIComponent(name)}`,
      role: 'user',
    };

    return this.serverClient.upsertUser(user);
  }

  async addMembersToVaultChannel(vaultId: string, userIds: string[]): Promise<boolean> {
    const channel = this.serverClient.channel('messaging', `vault-${vaultId}`);
    await channel.addMembers(userIds);
    return true;
  }

  async removeMembersFromVaultChannel(vaultId: string, userIds: string[]): Promise<boolean> {
    const channel = this.serverClient.channel('messaging', `vault-${vaultId}`);
    await channel.removeMembers(userIds);
    return true;
  }

  async getVaultChannelInfo(vaultId: string): Promise<{
    id: string;
    type: string;
    memberCount: number;
    createdAt: string;
    updatedAt: string;
    members: ChannelMemberResponse[];
  }> {
    const channel = this.serverClient.channel('messaging', `vault-${vaultId}`);
    const channelState = await channel.query();

    return {
      id: channel.id,
      type: channel.type,
      memberCount: Object.keys(channelState.members || {}).length,
      createdAt: channelState.channel?.created_at,
      updatedAt: channelState.channel?.updated_at,
      members: channelState.members,
    };
  }

  async sendSystemMessage(vaultId: string, text: string, data?: any): Promise<boolean> {
    const channel = this.serverClient.channel('messaging', `vault-${vaultId}`);

    await channel.sendMessage({
      text,
      user: { id: 'system', name: 'System' },
      type: 'system',
      ...data,
    });

    return true;
  }
}
