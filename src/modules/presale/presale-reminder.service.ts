import { readFileSync } from 'fs';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import Redis from 'ioredis';

import { PresaleService } from './presale.service';

import { NotificationService } from '@/modules/notification/notification.service';
import { REDIS_CLIENT } from '@/modules/redis/redis.module';

const HOUR_MS = 60 * 60 * 1000;

/** Hours-left marks that each get one email to the whole list, largest first. */
const MILESTONES_HOURS = [6, 3, 1] as const;

/**
 * A milestone only *starts* within this long after its mark, so a server that was
 * down at 6h left doesn't wake at 4h and announce "6 hours left". A batch that
 * already started keeps going past it (e.g. after a redeploy mid-send).
 */
const START_GRACE_MS = HOUR_MS;

/** Cached presale state older than this is not trusted to time a send. */
const MAX_STATE_AGE_MS = 2 * 60 * 1000;

const DEFAULT_WORKFLOW = 'mailsendcron';
const DEFAULT_RECIPIENTS_FILE = 'presale-reminder-recipients.txt';
const DEFAULT_DELAY_MS = 4000;
const MAX_ATTEMPTS = 3;
const KEY_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Sends the "[hours] hours left in the $L4VA Presale" emails to the whitelist
 * group at 6, 3 and 1 hours before `saleEndsAt`.
 *
 * Every minute it checks the cached presale state and, once a mark is crossed,
 * triggers the Novu workflow once per address with a pause between triggers.
 * Each address is claimed in Redis (SET NX) before its trigger, so a restart or
 * both blue/green containers running at once never double-send. The same key is
 * passed to Novu as the idempotency key.
 *
 * The list is read from a plain file (PRESALE_REMINDER_RECIPIENTS_FILE, default
 * presale-reminder-recipients.txt in the app root), which only the prod deploy
 * writes from its own secret. With no file the cron does nothing, so a testnet
 * deploy never mails anyone.
 */
@Injectable()
export class PresaleReminderService {
  private readonly logger = new Logger(PresaleReminderService.name);
  private readonly workflowId: string;
  private readonly delayMs: number;
  private readonly recipients: string[];
  private running = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly presaleService: PresaleService,
    private readonly notificationService: NotificationService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis
  ) {
    this.workflowId = this.configService.get<string>('PRESALE_REMINDER_WORKFLOW')?.trim() || DEFAULT_WORKFLOW;
    const delay = Number(this.configService.get<string>('PRESALE_REMINDER_DELAY_MS'));
    this.delayMs = Number.isFinite(delay) && delay >= 0 ? delay : DEFAULT_DELAY_MS;
    const file = this.configService.get<string>('PRESALE_REMINDER_RECIPIENTS_FILE')?.trim() || DEFAULT_RECIPIENTS_FILE;
    this.recipients = this.parseRecipients(this.readRecipientsFile(file));
    if (this.recipients.length) {
      this.logger.log(
        `Presale reminders on — workflow "${this.workflowId}", ${this.recipients.length} recipients, ` +
          `marks ${MILESTONES_HOURS.join('/')}h, ${this.delayMs}ms between sends`
      );
    }
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'presale-reminder' })
  async tick(): Promise<void> {
    if (!this.recipients.length || this.running) return;
    this.running = true;
    try {
      const milestone = await this.dueMilestone();
      if (milestone) await this.sendMilestone(milestone.hours, milestone.saleKey);
    } catch (err) {
      this.logger.error(`Presale reminder tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** The mark to send right now, if any: the smallest one already crossed. */
  private async dueMilestone(): Promise<{ hours: number; saleKey: string } | null> {
    const state = this.presaleService.getState();
    if (!state.configured || !state.updatedAt) return null;
    if (Date.now() - state.updatedAt > MAX_STATE_AGE_MS) {
      this.logger.warn('Presale state is stale — skipping reminder check.');
      return null;
    }
    // Only a running sale: not before it opens, not after it ends or sells out.
    if (state.phase !== 1 || state.paused) return null;
    if (state.hardCapL4va !== '0' && state.remainingL4va === '0') return null;

    const endsAtMs = Number(state.saleEndsAt) * 1000;
    if (!endsAtMs) return null;
    const leftMs = endsAtMs - Date.now();
    if (leftMs <= 0) return null;

    const hours = [...MILESTONES_HOURS].reverse().find(h => leftMs <= h * HOUR_MS);
    if (!hours) return null;

    // Scoped to the contract and end time, so a re-run sale starts clean.
    const saleKey = `presale-reminder:${state.address}:${state.saleEndsAt}:${hours}h`;
    const withinGrace = leftMs > hours * HOUR_MS - START_GRACE_MS;
    if (!withinGrace && !(await this.redis.exists(`${saleKey}:started`))) return null;

    return { hours, saleKey };
  }

  private async sendMilestone(hours: number, saleKey: string): Promise<void> {
    await this.redis.set(`${saleKey}:started`, new Date().toISOString(), 'EX', KEY_TTL_SECONDS, 'NX');

    let sent = 0;
    let failed = 0;
    for (const email of this.recipients) {
      const key = `${saleKey}:${email}`;
      const attemptsKey = `${key}:attempts`;
      if (Number(await this.redis.get(attemptsKey)) >= MAX_ATTEMPTS) continue;

      // Claim before sending: whoever wins the NX owns this address.
      const claimed = await this.redis.set(key, 'sending', 'EX', KEY_TTL_SECONDS, 'NX');
      if (!claimed) continue;

      try {
        const transactionId = await this.notificationService.triggerEmailWorkflow(
          this.workflowId,
          email,
          // hoursLabel spares the template a plural rule: "1 hour", "6 hours".
          { hours, hoursLabel: `${hours} ${hours === 1 ? 'hour' : 'hours'}`, email },
          key
        );
        await this.redis.set(key, transactionId || 'sent', 'EX', KEY_TTL_SECONDS);
        sent++;
      } catch (err) {
        // Release the claim so the next tick retries, up to MAX_ATTEMPTS.
        await this.redis.del(key);
        await this.redis.multi().incr(attemptsKey).expire(attemptsKey, KEY_TTL_SECONDS).exec();
        failed++;
        this.logger.error(`Presale ${hours}h reminder to ${email} failed: ${(err as Error).message}`);
      }

      if (this.delayMs) await new Promise(resolve => setTimeout(resolve, this.delayMs));
    }

    if (sent || failed) {
      this.logger.log(`Presale ${hours}h reminder: ${sent} sent, ${failed} failed this pass`);
    }
  }

  /** Missing file = no list; that is the normal state everywhere but prod. */
  private readRecipientsFile(file: string): string {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  }

  /** Lowercased, deduped, first occurrence wins; anything not email-shaped is dropped. */
  private parseRecipients(raw: string | undefined): string[] {
    const emails = (raw ?? '')
      .split(/[\s,;]+/)
      .map(e => e.trim().toLowerCase())
      .filter(Boolean);
    const invalid = emails.filter(e => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    if (invalid.length) this.logger.warn(`Ignoring ${invalid.length} malformed reminder address(es).`);
    return [...new Set(emails.filter(e => !invalid.includes(e)))];
  }
}
