/// <reference types="jest" />
import { StreamChat } from 'stream-chat';

import { ChatService } from './chat.service';

jest.mock('stream-chat');

describe('ChatService', () => {
  let service: ChatService;
  let serverClient: {
    createToken: jest.Mock;
    upsertUser: jest.Mock;
  };

  beforeEach(() => {
    serverClient = {
      createToken: jest.fn().mockReturnValue('signed-token'),
      upsertUser: jest.fn().mockResolvedValue({ users: {} }),
    };
    (StreamChat.getInstance as jest.Mock).mockReturnValue(serverClient);
    service = new ChatService();
  });

  describe('generateUserToken', () => {
    it('creates a Stream token with an expiry', () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

      const token = service.generateUserToken('user-1');

      expect(token).toBe('signed-token');
      expect(serverClient.createToken).toHaveBeenCalledWith(
        'user-1',
        Math.floor(1_700_000_000_000 / 1000) + ChatService.TOKEN_TTL_SECONDS
      );
      nowSpy.mockRestore();
    });
  });

  describe('createOrUpdateUser', () => {
    it('upserts the user with a server-assigned user role', async () => {
      await service.createOrUpdateUser('user-1', {
        name: 'Ada',
        image: 'https://example.com/ada.png',
      });

      expect(serverClient.upsertUser).toHaveBeenCalledWith({
        id: 'user-1',
        name: 'Ada',
        image: 'https://example.com/ada.png',
        role: 'user',
      });
    });

    it('does not take a Stream role from client input', async () => {
      await service.createOrUpdateUser('user-1', {
        name: 'Eve',
        // @ts-expect-error — role must not be accepted from callers
        role: 'admin',
      });

      expect(serverClient.upsertUser).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'user-1',
          role: 'user',
        })
      );
      expect(serverClient.upsertUser.mock.calls[0][0].role).toBe('user');
    });
  });
});
