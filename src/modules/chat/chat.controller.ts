import { Controller, Get, Post, Param, Body, HttpException, HttpStatus, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';

import { ChatService } from './chat.service';
import { AddMembersReq } from './dto/add-members.req';
import { AddMembersRes } from './dto/add-members.res';
import { CreateUserReq } from './dto/create-user.req';
import { CreateUserRes } from './dto/create-user.res';
import { CreateVaultChannelReq } from './dto/create-vault-channel.req';
import { CreateVaultChannelRes } from './dto/create-vault-channel.res';
import { GenerateTokenRes } from './dto/generate-token.res';

@ApiTags('chat')
@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Get('token/:userId')
  @ApiOperation({ summary: 'Generate Stream Chat token for user' })
  @ApiParam({ name: 'userId', description: 'User ID to generate token for' })
  @ApiResponse({ status: 200, description: 'Token generated successfully', type: GenerateTokenRes })
  async generateToken(@Param('userId', ParseUUIDPipe) userId: string): Promise<GenerateTokenRes> {
    try {
      const token = this.chatService.generateUserToken(userId);
      return { token };
    } catch (error) {
      throw new HttpException('Failed to generate token', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('vault/:vaultId/channel')
  @ApiOperation({ summary: 'Create or get vault chat channel' })
  @ApiParam({ name: 'vaultId', description: 'Vault ID to create channel for' })
  @ApiResponse({ status: 200, description: 'Channel created/retrieved successfully', type: CreateVaultChannelRes })
  async createVaultChannel(
    @Param('vaultId', ParseUUIDPipe) vaultId: string,
    @Body() body?: CreateVaultChannelReq
  ): Promise<CreateVaultChannelRes> {
    try {
      const channel = await this.chatService.createVaultChatRoom(vaultId, body?.createdByUserId || 'system');
      return {
        channelId: channel.id,
        channelType: channel.type,
        success: true,
      };
    } catch (error) {
      throw new HttpException('Failed to create vault channel', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('user/:userId')
  @ApiOperation({ summary: 'Create or update user in Stream Chat' })
  @ApiParam({ name: 'userId', description: 'User ID' })
  @ApiResponse({ status: 200, description: 'User created/updated successfully', type: CreateUserRes })
  async createUser(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() userData: CreateUserReq
  ): Promise<CreateUserRes> {
    try {
      const user = await this.chatService.createOrUpdateUser(userId, userData);
      return { user, success: true };
    } catch (error) {
      throw new HttpException('Failed to create user', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('vault/:vaultId/members')
  @ApiOperation({ summary: 'Add members to vault chat channel' })
  @ApiParam({ name: 'vaultId', description: 'Vault ID' })
  @ApiResponse({ status: 200, description: 'Members added successfully', type: AddMembersRes })
  async addMembersToVault(
    @Param('vaultId', ParseUUIDPipe) vaultId: string,
    @Body() body: AddMembersReq
  ): Promise<AddMembersRes> {
    try {
      await this.chatService.addMembersToVaultChannel(vaultId, body.userIds);
      return { success: true };
    } catch (error) {
      throw new HttpException('Failed to add members to vault channel', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
