import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';

import { REDIS_CLIENT } from '@/modules/redis/redis.module';

const KEY_PREFIX = 'cardano:admin-monitor:known-tx:';
/** Far longer than the monitor ever looks back. */
const TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Hashes of the Cardano transactions this backend submitted. The admin-address
 * monitor alerts on any admin spend that is not in here, so every submit path
 * must call {@link record}. A failed write only causes a false alert, never a
 * missed one, so it is logged and swallowed.
 */
@Injectable()
export class CardanoAdminTxRegistry {
  private readonly logger = new Logger(CardanoAdminTxRegistry.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async record(txHash: string | undefined | null): Promise<void> {
    if (!txHash) return;
    try {
      await this.redis.set(KEY_PREFIX + txHash.toLowerCase(), '1', 'EX', TTL_SECONDS);
    } catch (err) {
      this.logger.warn(`Could not record submitted tx ${txHash}: ${(err as Error).message}`);
    }
  }

  async isKnown(txHash: string): Promise<boolean> {
    return (await this.redis.exists(KEY_PREFIX + txHash.toLowerCase())) === 1;
  }
}
