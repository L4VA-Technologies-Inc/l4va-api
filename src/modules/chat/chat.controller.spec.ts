/// <reference types="jest" />
import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { AuthGuard } from '../auth/auth.guard';
import { AuthRequest } from '../auth/dto/auth-user.interface';
import { VaultsService } from '../vaults/vaults.service';

import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

jest.mock('../vaults/vaults.service', () => ({
  VaultsService: class VaultsService {},
}));

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const VAULT_ID = '33333333-3333-4333-8333-333333333333';

describe('ChatController', () => {
  let controller: ChatController;
  let chatService: {
    generateUserToken: jest.Mock;
    createOrUpdateUser: jest.Mock;
    createVaultChatRoom: jest.Mock;
    addMembersToVaultChannel: jest.Mock;
  };
  let vaultsService: {
    verifyChatAccess: jest.Mock;
  };

  const authedReq = { user: { sub: USER_ID } } as AuthRequest;

  beforeEach(async () => {
    chatService = {
      generateUserToken: jest.fn().mockReturnValue('stream-token'),
      createOrUpdateUser: jest.fn().mockResolvedValue({ users: {} }),
      createVaultChatRoom: jest.fn().mockResolvedValue({ id: `vault-${VAULT_ID}`, type: 'messaging' }),
      addMembersToVaultChannel: jest.fn().mockResolvedValue(true),
    };
    vaultsService = {
      verifyChatAccess: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        { provide: ChatService, useValue: chatService },
        { provide: VaultsService, useValue: vaultsService },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(ChatController);
  });

  describe('AuthGuard', () => {
    it('is applied to the controller', () => {
      const guards = Reflect.getMetadata('__guards__', ChatController);
      expect(guards).toContain(AuthGuard);
    });
  });

  describe('generateToken', () => {
    it('mints a token for the authenticated user', async () => {
      await expect(controller.generateToken(USER_ID, authedReq)).resolves.toEqual({ token: 'stream-token' });
      expect(chatService.generateUserToken).toHaveBeenCalledWith(USER_ID);
    });

    it('rejects minting a token for another user', async () => {
      await expect(controller.generateToken(OTHER_USER_ID, authedReq)).rejects.toBeInstanceOf(ForbiddenException);
      expect(chatService.generateUserToken).not.toHaveBeenCalled();
    });
  });

  describe('createUser', () => {
    it('upserts the authenticated user', async () => {
      await expect(controller.createUser(USER_ID, { name: 'Ada' }, authedReq)).resolves.toEqual({
        user: { users: {} },
        success: true,
      });
      expect(chatService.createOrUpdateUser).toHaveBeenCalledWith(USER_ID, { name: 'Ada' });
    });

    it('rejects upserting another user', async () => {
      await expect(controller.createUser(OTHER_USER_ID, { name: 'Eve' }, authedReq)).rejects.toBeInstanceOf(
        ForbiddenException
      );
      expect(chatService.createOrUpdateUser).not.toHaveBeenCalled();
    });
  });

  describe('createVaultChannel', () => {
    it('creates a channel as the authenticated user when they have vault chat access', async () => {
      await expect(controller.createVaultChannel(VAULT_ID, authedReq)).resolves.toEqual({
        channelId: `vault-${VAULT_ID}`,
        channelType: 'messaging',
        success: true,
      });
      expect(vaultsService.verifyChatAccess).toHaveBeenCalledWith(USER_ID, VAULT_ID);
      expect(chatService.createVaultChatRoom).toHaveBeenCalledWith(VAULT_ID, USER_ID);
    });

    it('rejects channel creation without vault chat access', async () => {
      vaultsService.verifyChatAccess.mockResolvedValue(false);

      await expect(controller.createVaultChannel(VAULT_ID, authedReq)).rejects.toBeInstanceOf(ForbiddenException);
      expect(chatService.createVaultChatRoom).not.toHaveBeenCalled();
    });
  });

  describe('addMembersToVault', () => {
    it('adds the authenticated user to a vault they can access', async () => {
      await expect(controller.addMembersToVault(VAULT_ID, { userIds: [USER_ID] }, authedReq)).resolves.toEqual({
        success: true,
      });
      expect(chatService.addMembersToVaultChannel).toHaveBeenCalledWith(VAULT_ID, [USER_ID]);
    });

    it('rejects adding any other user', async () => {
      await expect(
        controller.addMembersToVault(VAULT_ID, { userIds: [OTHER_USER_ID] }, authedReq)
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(chatService.addMembersToVaultChannel).not.toHaveBeenCalled();
    });

    it('rejects membership changes without vault chat access', async () => {
      vaultsService.verifyChatAccess.mockResolvedValue(false);

      await expect(controller.addMembersToVault(VAULT_ID, { userIds: [USER_ID] }, authedReq)).rejects.toBeInstanceOf(
        ForbiddenException
      );
      expect(chatService.addMembersToVaultChannel).not.toHaveBeenCalled();
    });
  });
});
