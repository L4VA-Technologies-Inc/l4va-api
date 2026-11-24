import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import Redis from 'ioredis';

import { REDIS_CLIENT } from './redis.constants';

import { AlertsService } from '@/modules/alerts/alerts.service';

/**
 * Slack alerts for Redis outages (DNS failure, refused connection, retry limit…).
 *
 * Two signals, so neither a noisy nor a silent failure is missed:
 * - the shared client's `error` event fires as soon as a connection attempt fails;
 * - a PING every minute catches a client that is stuck reconnecting without emitting.
 *
 * Bull/BullMQ use the same host, so an outage seen here covers the queues too.
 * AlertsService posts straight to Slack over HTTP with an in-memory cooldown,
 * so alerting does not depend on the Redis that is down.
 */
@Injectable()
export class RedisHealthService implements OnModuleInit {
  private readonly logger = new Logger(RedisHealthService.name);
  private readonly target: string;
  /** Set when the first failure of an outage is seen; cleared on recovery. */
  private downSince: number | null = null;
  private lastError: string | null = null;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly alerts: AlertsService,
    configService: ConfigService
  ) {
    const host = configService.get<string>('REDIS_HOST');
    const port = configService.get<string>('REDIS_PORT') ?? '6379';
    const db = configService.get<string>('REDIS_DB') ?? '0';
    this.target = `${host}:${port}/${db}`;
  }

  onModuleInit(): void {
    // Also stops ioredis from logging "Unhandled error event" for this client.
    this.redis.on('error', (error: NodeJS.ErrnoException) => this.markDown(error));
    this.redis.on('ready', () => this.markUp());
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async checkHealth(): Promise<void> {
    try {
      await Promise.race([
        this.redis.ping(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('PING timed out after 5s')), 5000)),
      ]);
      this.markUp();
    } catch (error) {
      this.markDown(error as NodeJS.ErrnoException);
    }
  }

  private markDown(error: NodeJS.ErrnoException): void {
    const message = error?.code ? `${error.code}: ${error.message}` : (error?.message ?? String(error));
    this.lastError = message;
    if (this.downSince === null) {
      this.downSince = Date.now();
      this.logger.error(`Redis unavailable (${this.target}): ${message}`);
    }
    // Cooldown in AlertsService keeps this to one Slack message per hour during a long outage.
    void this.alerts.sendAlert('redis_unavailable', {
      target: this.target,
      error: message,
      downSince: new Date(this.downSince).toISOString(),
    });
  }

  private markUp(): void {
    if (this.downSince === null) return;
    const downForSec = Math.round((Date.now() - this.downSince) / 1000);
    this.logger.log(`Redis recovered (${this.target}) after ${downForSec}s`);
    void this.alerts.sendAlert('redis_recovered', {
      target: this.target,
      downForSec,
      lastError: this.lastError,
    });
    this.downSince = null;
    this.lastError = null;
  }
}
