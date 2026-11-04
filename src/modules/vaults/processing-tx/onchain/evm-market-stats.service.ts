import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { EvmLiquidityService } from './evm-liquidity.service';
import { EvmLpStatus } from './evm-lp.config';

import { Market } from '@/database/market.entity';
import { Vault } from '@/database/vault.entity';
import { AlertsService } from '@/modules/alerts/alerts.service';
import { PriceService } from '@/modules/price/price.service';
import { MarketType } from '@/types/market.types';
import { ChainType, VAULT_STATUSES_WITH_POTENTIAL_LP } from '@/types/vault.types';

/**
 * Market rows for Robinhood vault tokens, the EVM side of VaultMarketStatsService
 * (which only knows Cardano units and DexHunter). Price comes from the vault's own
 * Uniswap pool; values are stored in ADA like the Cardano rows so the Tokens table
 * maps both the same way.
 */
@Injectable()
export class EvmMarketStatsService {
  private readonly logger = new Logger(EvmMarketStatsService.name);
  private readonly isMainnet: boolean;

  constructor(
    @InjectRepository(Vault) private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Market) private readonly marketRepository: Repository<Market>,
    private readonly liquidityService: EvmLiquidityService,
    private readonly priceService: PriceService,
    configService: ConfigService,
    private readonly alerts: AlertsService
  ) {
    this.isMainnet = configService.get<string>('CARDANO_NETWORK') === 'mainnet';
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async scheduledUpdate(): Promise<void> {
    // Testnet lists vault tokens from NAV and never reads market rows.
    if (!this.isMainnet) return;
    try {
      await this.updateAll();
    } catch (error) {
      this.logger.error(`EVM market stats update failed: ${(error as Error).message}`);
      void this.alerts.sendAlert('evm_market_stats_failed', {
        chain: 'robinhood',
        pass: 'all',
        error: (error as Error).message,
      });
    }
  }

  /** A freshly seeded pool shows up in the Tokens table within a minute instead of waiting for the full pass. */
  @Cron(CronExpression.EVERY_MINUTE)
  async scheduledNewVaults(): Promise<void> {
    if (!this.isMainnet) return;
    try {
      await this.update(true);
    } catch (error) {
      this.logger.error(`EVM market stats (new vaults) failed: ${(error as Error).message}`);
      void this.alerts.sendAlert('evm_market_stats_failed', {
        chain: 'robinhood',
        pass: 'new_vaults',
        error: (error as Error).message,
      });
    }
  }

  async updateAll(): Promise<void> {
    await this.update(false);
  }

  private async update(onlyWithoutMarket: boolean): Promise<void> {
    const query = this.vaultRepository
      .createQueryBuilder('v')
      .select(['v.id', 'v.name', 'v.ft_token_supply', 'v.total_assets_cost_ada'])
      .where('v.chain_type = :chain', { chain: ChainType.robinhood })
      .andWhere('v.has_active_lp = true')
      .andWhere('v.vault_status IN (:...statuses)', { statuses: VAULT_STATUSES_WITH_POTENTIAL_LP });
    if (onlyWithoutMarket) {
      query.andWhere('NOT EXISTS (SELECT 1 FROM markets m WHERE m.vault_id = v.id)');
    }
    const vaults = await query.getMany();
    if (vaults.length === 0) return;

    const [ethUsd, adaUsd] = await Promise.all([this.priceService.getEthPrice(), this.priceService.getAdaPrice()]);
    if (!(ethUsd > 0) || !(adaUsd > 0)) {
      this.logger.warn('EVM market stats skipped: no ETH/ADA price');
      return;
    }
    const adaPerEth = ethUsd / adaUsd;

    let updated = 0;
    for (const vault of vaults) {
      try {
        const lp = await this.liquidityService.getVaultLp(vault.id);
        const priceEth = Number(lp?.vtPriceNative ?? 0);
        if (lp?.status !== EvmLpStatus.provided || !(priceEth > 0)) continue;

        const priceAda = priceEth * adaPerEth;
        const supply = Number(vault.ft_token_supply ?? 0);
        const fdvAda = priceAda * supply;
        const tvlAda = Number(vault.total_assets_cost_ada ?? 0);

        await this.vaultRepository.update({ id: vault.id }, { vt_price: priceAda, fdv: fdvAda });
        await this.upsertMarket(vault.id, {
          mcap: fdvAda,
          totalSupply: supply,
          circSupply: supply,
          // Both sides of the pool, valued at the pool price.
          totalAdaLiquidity: Number(lp.reserveNative ?? 0) * 2 * adaPerEth,
          delta: tvlAda > 0 ? (fdvAda / tvlAda) * 100 : null,
        });
        updated++;
      } catch (error) {
        this.logger.warn(`EVM market stats failed for vault ${vault.id}: ${(error as Error).message}`);
      }
    }
    if (updated > 0 || !onlyWithoutMarket) {
      this.logger.log(`EVM market stats: updated ${updated}/${vaults.length} vault tokens`);
    }
  }

  private async upsertMarket(vaultId: string, data: Partial<Market>): Promise<void> {
    const existing = await this.marketRepository.findOne({ where: { vault_id: vaultId } });
    await this.marketRepository.save(
      existing
        ? Object.assign(existing, data)
        : this.marketRepository.create({ ...data, vault_id: vaultId, type: MarketType.vault_token })
    );
  }
}
