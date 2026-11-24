import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Vault } from '@/database/vault.entity';
import { VaultStatus } from '@/types/vault.types';

/** Statuses in which a ticker is reserved — the same set `createVault` rejects a duplicate against. */
const TICKER_HOLDING_STATUSES = [
  VaultStatus.published,
  VaultStatus.contribution,
  VaultStatus.acquire,
  VaultStatus.locked,
];

const MAX_TICKER_LENGTH = 9;
const MAX_SUFFIX = 99;

/**
 * Tells the vault assistant which tickers are already taken, so it never proposes one that
 * `createVault` would reject at launch. Compared case-insensitively: "LAVA" and "Lava" would read as
 * the same token to users even though the create check is exact.
 */
@Injectable()
export class TickerAvailabilityService {
  constructor(@InjectRepository(Vault) private readonly vaultRepository: Repository<Vault>) {}

  async isTaken(ticker: string): Promise<boolean> {
    const value = ticker?.trim();
    if (!value) return false;
    return this.vaultRepository
      .createQueryBuilder('vault')
      .where('UPPER(vault.vault_token_ticker) = UPPER(:ticker)', { ticker: value })
      .andWhere('vault.vault_status IN (:...statuses)', { statuses: TICKER_HOLDING_STATUSES })
      .getExists();
  }

  /**
   * `ticker` itself when free; otherwise the first free `<ticker><n>` (n = 2..99), trimmed to fit 9
   * characters. Null when no variant is free, so the caller leaves the ticker unset.
   */
  async firstFreeVariant(ticker: string): Promise<string | null> {
    const base = ticker.trim();
    const prefix = base.slice(0, MAX_TICKER_LENGTH - 2);
    const rows = await this.vaultRepository
      .createQueryBuilder('vault')
      .select('UPPER(vault.vault_token_ticker)', 'ticker')
      .where('UPPER(vault.vault_token_ticker) LIKE UPPER(:prefix)', { prefix: `${prefix}%` })
      .andWhere('vault.vault_status IN (:...statuses)', { statuses: TICKER_HOLDING_STATUSES })
      .getRawMany<{ ticker: string }>();
    const taken = new Set(rows.map(row => row.ticker));

    if (!taken.has(base.toUpperCase())) return base;
    for (let n = 2; n <= MAX_SUFFIX; n += 1) {
      const suffix = String(n);
      const candidate = `${base.slice(0, MAX_TICKER_LENGTH - suffix.length)}${suffix}`;
      if (!taken.has(candidate.toUpperCase())) return candidate;
    }
    return null;
  }
}
