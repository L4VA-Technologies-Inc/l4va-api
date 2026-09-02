import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AuthGuard } from '../auth/auth.guard';
import { AuthRequest } from '../auth/dto/auth-user.interface';
import { VaultsService } from '../vaults/vaults.service';

import { ChatService } from './chat.service';
import { AddMembersReq } from './dto/add-members.req';
import { AddMembersRes } from './dto/add-members.res';
import { CreateUserReq } from './dto/create-user.req';
import { CreateUserRes } from './dto/create-user.res';
import { CreateVaultChannelRes } from './dto/create-vault-channel.res';
import { GenerateTokenRes } from './dto/generate-token.res';

@ApiTags('chat')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('chat')
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly vaultsService: VaultsService
  ) {}

  @Get('token/:userId')
  @ApiOperation({ summary: 'Generate Stream Chat token for the authenticated user' })
  @ApiParam({ name: 'userId', description: 'Must match the authenticated user ID' })
  @ApiResponse({ status: 200, description: 'Token generated successfully', type: GenerateTokenRes })
  async generateToken(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Request() req: AuthRequest
  ): Promise<GenerateTokenRes> {
    this.assertSelf(userId, req.user.sub);

    try {
      const token = this.chatService.generateUserToken(userId);
      return { token };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException('Failed to generate token', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('vault/:vaultId/channel')
  @ApiOperation({ summary: 'Create or get vault chat channel' })
  @ApiParam({ name: 'vaultId', description: 'Vault ID to create channel for' })
  @ApiResponse({ status: 200, description: 'Channel created/retrieved successfully', type: CreateVaultChannelRes })
  async createVaultChannel(
    @Param('vaultId', ParseUUIDPipe) vaultId: string,
    @Request() req: AuthRequest
  ): Promise<CreateVaultChannelRes> {
    await this.assertVaultChatAccess(req.user.sub, vaultId);

    try {
      const channel = await this.chatService.createVaultChatRoom(vaultId, req.user.sub);
      return {
        channelId: channel.id,
        channelType: channel.type,
        success: true,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException('Failed to create vault channel', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('user/:userId')
  @ApiOperation({ summary: 'Create or update the authenticated user in Stream Chat' })
  @ApiParam({ name: 'userId', description: 'Must match the authenticated user ID' })
  @ApiResponse({ status: 200, description: 'User created/updated successfully', type: CreateUserRes })
  async createUser(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() userData: CreateUserReq,
    @Request() req: AuthRequest
  ): Promise<CreateUserRes> {
    this.assertSelf(userId, req.user.sub);

    try {
      const user = await this.chatService.createOrUpdateUser(userId, userData);
      return { user, success: true };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException('Failed to create user', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('vault/:vaultId/members')
  @ApiOperation({ summary: 'Add the authenticated user to a vault chat channel' })
  @ApiParam({ name: 'vaultId', description: 'Vault ID' })
  @ApiResponse({ status: 200, description: 'Members added successfully', type: AddMembersRes })
  async addMembersToVault(
    @Param('vaultId', ParseUUIDPipe) vaultId: string,
    @Body() body: AddMembersReq,
    @Request() req: AuthRequest
  ): Promise<AddMembersRes> {
    if (body.userIds.some(id => id !== req.user.sub)) {
      throw new ForbiddenException('You can only add yourself to a vault channel');
    }

    await this.assertVaultChatAccess(req.user.sub, vaultId);

    try {
      await this.chatService.addMembersToVaultChannel(vaultId, [req.user.sub]);
      return { success: true };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException('Failed to add members to vault channel', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  private assertSelf(requestedUserId: string, authenticatedUserId: string): void {
    if (requestedUserId !== authenticatedUserId) {
      throw new ForbiddenException('You can only access chat identity for your own account');
    }
  }

  private async assertVaultChatAccess(userId: string, vaultId: string): Promise<void> {
    const allowed = await this.vaultsService.verifyChatAccess(userId, vaultId);
    if (!allowed) {
      throw new ForbiddenException('You do not have access to this vault chat');
    }
  }
}
