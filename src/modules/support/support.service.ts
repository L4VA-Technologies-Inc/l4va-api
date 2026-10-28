import { HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

import { CreateSupportRequestReq } from './dto/create-support-request.req';

import { AuthUser } from '@/modules/auth/dto/auth-user.interface';

// Per-IP limits for an unauthenticated form (in-memory: single API instance).
const RATE_LIMITS = [
  { windowMs: 10 * 60 * 1000, max: 3 },
  { windowMs: 24 * 60 * 60 * 1000, max: 10 },
];
const L4VA_GREEN = 0x00c805;

@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);
  private readonly webhookUrl?: string;
  private readonly hitsByIp = new Map<string, number[]>();

  constructor(configService: ConfigService) {
    this.webhookUrl = configService.get<string>('DISCORD_SUPPORT_WEBHOOK_URL');
  }

  async createRequest(body: CreateSupportRequestReq, ip: string, user?: AuthUser): Promise<void> {
    // Bots fill every field; pretend success so they don't retry.
    if (body.website) return;

    if (!this.webhookUrl) {
      throw new ServiceUnavailableException('Support is not configured');
    }
    this.consumeRateLimit(ip);

    const message = body.message.trim();
    const wallet = user?.address || body.walletAddress;
    const fields = [
      { name: 'Email', value: body.email, inline: true },
      { name: 'Chain', value: body.chain || '—', inline: true },
      { name: 'Logged in', value: user ? 'yes' : 'no', inline: true },
      { name: user ? 'Wallet (verified)' : 'Wallet (unverified)', value: wallet ? `\`${wallet}\`` : '—' },
      ...(body.pageUrl ? [{ name: 'Page', value: body.pageUrl }] : []),
    ];

    const threadName = `${message.replace(/\s+/g, ' ').slice(0, 70)} — ${body.email}`.slice(0, 100);
    const payload = {
      username: 'L4VA Support',
      // User text must never ping @everyone / roles.
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: 'New support request',
          description: message,
          color: L4VA_GREEN,
          fields,
          timestamp: new Date().toISOString(),
        },
      ],
    };

    try {
      // Forum channels need a post title (thread_name); text channels reject it with 400.
      await this.post({ ...payload, thread_name: threadName }).catch(error => {
        if (axios.isAxiosError(error) && error.response?.status === 400) return this.post(payload);
        throw error;
      });
    } catch (error) {
      this.logger.error(`Discord support webhook failed: ${error?.message}`);
      throw new HttpException('Could not send your message, please try again later', HttpStatus.BAD_GATEWAY);
    }
  }

  private post(payload: object): Promise<unknown> {
    return axios.post(this.webhookUrl, payload, { timeout: 10_000 });
  }

  private consumeRateLimit(ip: string): void {
    const now = Date.now();
    const longestWindow = Math.max(...RATE_LIMITS.map(l => l.windowMs));
    const hits = (this.hitsByIp.get(ip) || []).filter(t => now - t < longestWindow);

    for (const { windowMs, max } of RATE_LIMITS) {
      if (hits.filter(t => now - t < windowMs).length >= max) {
        throw new HttpException('Too many support requests, please try again later', HttpStatus.TOO_MANY_REQUESTS);
      }
    }
    hits.push(now);
    this.hitsByIp.set(ip, hits);

    // Keep the map from growing without bound.
    if (this.hitsByIp.size > 10_000) {
      for (const [key, times] of this.hitsByIp) {
        if (!times.some(t => now - t < longestWindow)) this.hitsByIp.delete(key);
      }
    }
  }
}
