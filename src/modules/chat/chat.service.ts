import { Injectable, Logger } from '@nestjs/common';
import { StreamChat } from 'stream-chat';

@Injectable()
export class ChatService {
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
    try {
      const token = this.serverClient.createToken(userId);
      return token;
    } catch (error) {
      throw error;
    }
  }

  async createOrUpdateUser(userId: string, userData: { name?: string; image?: string; role?: string }) {
    try {
      const user = {
        id: userId,
        name: userData.name || `User ${userId}`,
        image: userData.image || `https://getstream.io/random_png/?id=${userId}&name=${userData.name || userId}`,
        role: userData.role || 'user',
        ...userData,
      };

      const response = await this.serverClient.upsertUser(user);
      return response;
    } catch (error) {
      throw error;
    }
  }

  async addMembersToVaultChannel(vaultId: string, userIds: string[]) {
    try {
      const channel = this.serverClient.channel('messaging', `vault-${vaultId}`);
      await channel.addMembers(userIds);
      return true;
    } catch (error) {
      throw error;
    }
  }

  async removeMembersFromVaultChannel(vaultId: string, userIds: string[]) {
    try {
      const channel = this.serverClient.channel('messaging', `vault-${vaultId}`);
      await channel.removeMembers(userIds);
      return true;
    } catch (error) {
      throw error;
    }
  }

  async getVaultChannelInfo(vaultId: string) {
    try {
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
    } catch (error) {
      throw error;
    }
  }

  async sendSystemMessage(vaultId: string, text: string, data?: any) {
    try {
      const channel = this.serverClient.channel('messaging', `vault-${vaultId}`);

      await channel.sendMessage({
        text,
        user: { id: 'system', name: 'System' },
        type: 'system',
        ...data,
      });

      return true;
    } catch (error) {
      throw error;
    }
  }
}
