import { ApiTags, ApiOperation, ApiParam, ApiResponse } from "@nestjs/swagger";
import { Controller, Get, Post, Param, Body, HttpException, HttpStatus } from "@nestjs/common";
import { ChatService } from "./chat.service";

@ApiTags('chat')
@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Get('token/:userId')
  @ApiOperation({ summary: 'Generate Stream Chat token for user' })
  @ApiParam({ name: 'userId', description: 'User ID to generate token for' })
  @ApiResponse({ status: 200, description: 'Token generated successfully' })
  async generateToken(@Param('userId') userId: string) {
    try {
      const token = this.chatService.generateUserToken(userId);
      return { token };
    } catch (error) {
      throw new HttpException(
        'Failed to generate token',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Post('vault/:vaultId/channel')
  @ApiOperation({ summary: 'Create or get vault chat channel' })
  @ApiParam({ name: 'vaultId', description: 'Vault ID to create channel for' })
  @ApiResponse({ status: 200, description: 'Channel created/retrieved successfully' })
  async createVaultChannel(
    @Param('vaultId') vaultId: string,
    @Body() body?: { createdByUserId?: string }
  ) {
    try {
      const channel = await this.chatService.createVaultChatRoom(
        vaultId, 
        body?.createdByUserId || 'system'
      );
      return {
        channelId: channel.id,
        channelType: channel.type,
        success: true
      };
    } catch (error) {
      throw new HttpException(
        'Failed to create vault channel',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Post('user/:userId')
  @ApiOperation({ summary: 'Create or update user in Stream Chat' })
  @ApiParam({ name: 'userId', description: 'User ID' })
  async createUser(
    @Param('userId') userId: string,
    @Body() userData: { name?: string; image?: string; role?: string }
  ) {
    try {
      const user = await this.chatService.createOrUpdateUser(userId, userData);
      return { user, success: true };
    } catch (error) {
      throw new HttpException(
        'Failed to create user',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Post('vault/:vaultId/members')
  @ApiOperation({ summary: 'Add members to vault chat channel' })
  @ApiParam({ name: 'vaultId', description: 'Vault ID' })
  async addMembersToVault(
    @Param('vaultId') vaultId: string,
    @Body() body: { userIds: string[] }
  ) {
    try {
      await this.chatService.addMembersToVaultChannel(vaultId, body.userIds);
      return { success: true };
    } catch (error) {
      throw new HttpException(
        'Failed to add members to vault channel',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }
}