import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type Redis from 'ioredis';

import { CardanoAdminTxRegistry } from './cardano-admin-tx.registry';

import { AlertsService } from '@/modules/alerts/alerts.service';
import { REDIS_CLIENT } from '@/modules/redis/redis.module';

const CURSOR_KEY = 'cardano:admin-monitor:last-block-height';
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

type AddressTx = { tx_hash: string; block_height: number; block_time: number };

/**
 * Alerts when the Cardano admin key spends from the admin address in a
 * transaction this backend did not submit — the signature of a stolen
 * `ADMIN_S_KEY` being used elsewhere.
 *
 * Every 5 minutes it reads the admin address's new transactions from
 * Blockfrost and checks each one that consumes an admin UTxO (as input or
 * collateral) against {@link CardanoAdminTxRegistry}. Incoming payments are
 * ignored. The first run only records the current height, so history never
 * alerts.
 *
 * Not covered: a transaction signed with the admin key whose fees and inputs
 * come from another wallet (for example a vault datum rewrite paid by the
 * attacker). That needs scanning the script addresses for the admin key hash
 * in required signers.
 *
 * Enabled with CARDANO_ADMIN_TX_MONITOR_ENABLED=true. Run it in one
 * environment per admin address; another environment sharing the address
 * writes to its own Redis, so its transactions would alert here.
 */
@Injectable()
export class CardanoAdminTxMonitorService {
  private readonly logger = new Logger(CardanoAdminTxMonitorService.name);
  private readonly enabled: boolean;
  private readonly adminAddress: string | undefined;
  private readonly explorer: string;
  // Not readonly so specs can swap in a fake.
  private blockfrost: BlockFrostAPI | null;
  private running = false;

  constructor(
    configService: ConfigService,
    private readonly registry: CardanoAdminTxRegistry,
    private readonly alerts: AlertsService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis
  ) {
    this.enabled = configService.get<string>('CARDANO_ADMIN_TX_MONITOR_ENABLED') === 'true';
    this.adminAddress = configService.get<string>('ADMIN_ADDRESS');
    const projectId = configService.get<string>('BLOCKFROST_API_KEY');
    this.blockfrost = projectId ? new BlockFrostAPI({ projectId }) : null;
    this.explorer =
      configService.get<string>('NETWORK_ID') === '1'
        ? 'https://cardanoscan.io/transaction/'
        : 'https://preprod.cardanoscan.io/transaction/';

    if (this.enabled && (!this.adminAddress || !this.blockfrost)) {
      this.logger.error(
        'Admin tx monitor enabled, but ADMIN_ADDRESS or BLOCKFROST_API_KEY is missing; it will not run'
      );
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'cardano-admin-tx-monitor' })
  async check(): Promise<void> {
    if (!this.enabled || !this.adminAddress || !this.blockfrost || this.running) return;
    this.running = true;
    try {
      await this.scan();
    } catch (err) {
      this.logger.error(`Admin tx monitor run failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async scan(): Promise<void> {
    const stored = await this.redis.get(CURSOR_KEY);
    const cursor = stored === null ? null : Number(stored);
    const fresh = await this.newTransactions(cursor);

    if (cursor === null) {
      const latest = fresh[fresh.length - 1]?.block_height ?? 0;
      await this.redis.set(CURSOR_KEY, String(latest));
      this.logger.log(`Admin tx monitor started at block ${latest}; earlier transactions are not checked`);
      return;
    }

    for (const tx of fresh) {
      // Stop at a failed lookup without moving the cursor past it, so the next run retries it.
      if (!(await this.inspect(tx))) return;
      await this.redis.set(CURSOR_KEY, String(tx.block_height));
    }
  }

  /** Transactions of the admin address above the cursor, oldest first. */
  private async newTransactions(cursor: number | null): Promise<AddressTx[]> {
    const found: AddressTx[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      let batch: AddressTx[];
      try {
        batch = (await this.blockfrost!.addressesTransactions(this.adminAddress!, {
          count: PAGE_SIZE,
          page,
          order: 'desc',
        })) as AddressTx[];
      } catch (err) {
        // Blockfrost answers 404 for an address with no history.
        if ((err as { status_code?: number }).status_code === 404) break;
        throw err;
      }
      for (const tx of batch) {
        if (cursor !== null && tx.block_height <= cursor) return found.reverse();
        found.push(tx);
      }
      // First run: the newest page is enough to set the starting height.
      if (cursor === null || batch.length < PAGE_SIZE) break;
    }
    if (cursor !== null && found.length >= PAGE_SIZE * MAX_PAGES) {
      this.logger.warn(`Admin tx monitor: more than ${found.length} new transactions; older ones were skipped`);
    }
    return found.reverse();
  }

  /** Alerts on an unknown admin spend. Returns false when the transaction could not be read. */
  private async inspect(tx: AddressTx): Promise<boolean> {
    if (await this.registry.isKnown(tx.tx_hash)) return true;

    let utxos: Awaited<ReturnType<BlockFrostAPI['txsUtxos']>>;
    try {
      utxos = await this.blockfrost!.txsUtxos(tx.tx_hash);
    } catch (err) {
      this.logger.warn(`Admin tx monitor: cannot read ${tx.tx_hash}: ${(err as Error).message}`);
      return false;
    }

    const spent = utxos.inputs.filter(input => input.address === this.adminAddress);
    if (spent.length === 0) return true; // a payment to the admin address, not a spend

    const lovelace = (amounts: { unit: string; quantity: string }[]): bigint =>
      amounts.filter(a => a.unit === 'lovelace').reduce((sum, a) => sum + BigInt(a.quantity), 0n);
    const outgoing = utxos.outputs.filter(output => output.address !== this.adminAddress);

    const details = {
      txHash: tx.tx_hash,
      explorer: this.explorer + tx.tx_hash,
      blockHeight: tx.block_height,
      blockTime: new Date(tx.block_time * 1000).toISOString(),
      adminInputsSpent: spent.length,
      collateralOnly: spent.every(input => input.collateral),
      adaSentElsewhere: (Number(outgoing.reduce((sum, o) => sum + lovelace(o.amount), 0n)) / 1e6).toFixed(6),
      recipients: [...new Set(outgoing.map(o => o.address))].slice(0, 10),
      note: 'The admin key spent from the admin address in a transaction this backend did not submit.',
    };

    this.logger.error(`Unknown admin transaction ${tx.tx_hash}: ${JSON.stringify(details)}`);
    // One alert type per transaction, so the per-type cooldown can never hide a second one.
    await this.alerts.sendAlert(`cardano_admin_unknown_tx:${tx.tx_hash}`, details);
    return true;
  }
}
