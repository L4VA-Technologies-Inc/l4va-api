import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { encodePacked, keccak256, zeroAddress, type Address } from 'viem';

import { IndexSwapRouteService } from './index-swap-route.service';

import { EvmSnapshotStatus, EvmValuationSnapshot } from '@/database/evm-valuation-snapshot.entity';
import { Vault } from '@/database/vault.entity';
import { AlertsService } from '@/modules/alerts/alerts.service';
import { EvmContractReader } from '@/modules/vaults/processing-tx/onchain/evm-contract-reader.service';
import { EvmLpStatus, type EvmLpCarveoutRecord } from '@/modules/vaults/processing-tx/onchain/evm-lp.config';
import { EvmSwapService } from '@/modules/vaults/processing-tx/onchain/evm-swap.service';
import { EvmLpMode, vaultIsV13, VAULT_V13_ABI } from '@/modules/vaults/processing-tx/onchain/evm-v13';
import { ChainType } from '@/types/vault.types';

const DEADLINE_SECONDS = 20 * 60;

/**
 * V13 FromSale vaults (asset-only, with an LP share) fund their pool by selling exactly the
 * vault's lp%/2 slice (Cardano math) of every token it held when the raise closed. The contract records the
 * slices and only lets `swapForLp` sell inside them; `provideLiquidity` then prices the pool from
 * the proceeds (`EvmLiquidityService`). This sells whatever is left of each slice, one swap per
 * token per tick, with the same routing and slippage floor as index rebalances.
 *
 * Idempotent: what is left comes from the chain (`lpSlice`), and each sale's operation id is
 * keyed to how much of the slice was already sold.
 */
@Injectable()
export class EvmV13LpSaleService {
  private readonly logger = new Logger(EvmV13LpSaleService.name);
  private readonly slippageBps: number;
  private readonly processing = new Set<string>();

  constructor(
    @InjectRepository(EvmValuationSnapshot) private readonly snapshotsRepository: Repository<EvmValuationSnapshot>,
    @InjectRepository(Vault) private readonly vaultsRepository: Repository<Vault>,
    private readonly contractReader: EvmContractReader,
    private readonly swapService: EvmSwapService,
    private readonly routes: IndexSwapRouteService,
    private readonly alerts: AlertsService,
    configService: ConfigService
  ) {
    this.slippageBps = Number(configService.get<string>('EVM_SWAP_SLIPPAGE_BPS') ?? '50');
  }

  /** Cron entry: every confirmed FromSale raise whose pool is not seeded yet. */
  async runPendingSales(): Promise<void> {
    const pending = await this.snapshotsRepository
      .createQueryBuilder('snap')
      .innerJoin(Vault, 'vault', 'vault.id = snap.vault_id')
      .where('snap.status = :status', { status: EvmSnapshotStatus.confirmed })
      .andWhere(`snap.lp_carveout->>'status' = :lp`, { lp: EvmLpStatus.pending })
      .andWhere(`snap.lp_carveout->>'lpMode' = :mode`, { mode: String(EvmLpMode.FromSale) })
      .andWhere('vault.chain_type = :chain', { chain: ChainType.robinhood })
      .getMany();

    for (const snap of pending) {
      if (this.processing.has(snap.id)) continue;
      this.processing.add(snap.id);
      try {
        await this.sellSlices(snap);
      } catch (err) {
        this.logger.error(`LP sale for snapshot ${snap.id} failed: ${(err as Error).message}`);
        void this.alerts.sendAlert('evm_lp_failed', {
          chain: 'robinhood',
          snapshotId: snap.id,
          error: (err as Error).message,
        });
      } finally {
        this.processing.delete(snap.id);
      }
    }
  }

  /** True when every slice is sold (the pool can be seeded). */
  async allSlicesSold(vaultAddress: Address): Promise<boolean> {
    for (const token of await this.sliceTokens(vaultAddress)) {
      const [slice, sold] = await this.slice(vaultAddress, token);
      if (sold < slice) return false;
    }
    return true;
  }

  private async sellSlices(snap: EvmValuationSnapshot): Promise<void> {
    const vault = await this.vaultsRepository.findOne({ where: { id: snap.vault_id } });
    if (!vault?.contract_address || !vaultIsV13(vault)) return;
    const vaultAddress = vault.contract_address as Address;

    const adapter = this.routes.tradingAdapterFor(vault);
    const tradeFeeBps = await this.swapService.tradeFeeBps(vaultAddress);

    for (const token of await this.sliceTokens(vaultAddress)) {
      const [slice, sold] = await this.slice(vaultAddress, token);
      const left = slice - sold;
      if (left <= 0n) continue;

      const operationId = keccak256(
        encodePacked(['address', 'address', 'uint256', 'string'], [vaultAddress, token, sold, 'l4va-v13-lp-sale'])
      );
      if (await this.swapService.isOperationIdUsed(vaultAddress, operationId)) continue;

      const { params } = await this.routes.prepareSwap({
        vaultAddress,
        adapter,
        operationId,
        assetIn: token,
        assetOut: zeroAddress,
        amountIn: left,
        deadline: BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS),
        slippageBps: this.slippageBps,
        tradeFeeBps,
      });
      const res = await this.swapService.swap(vault.id, params, { forLp: true });
      this.logger.log(
        `V13 LP sale vault=${vault.id} token=${token} amount=${left} → ${res.grossOut - res.fee} wei tx=${res.txHash}`
      );

      const fresh = (await this.snapshotsRepository.findOne({ where: { id: snap.id } }))
        ?.lp_carveout as unknown as EvmLpCarveoutRecord;
      const sales = { ...(fresh?.lpSales ?? {}) };
      sales[token.toLowerCase()] = (BigInt(sales[token.toLowerCase()] ?? '0') + res.grossOut - res.fee).toString();
      await this.snapshotsRepository.update({ id: snap.id }, { lp_carveout: { ...fresh, lpSales: sales } });
    }
  }

  private async sliceTokens(vaultAddress: Address): Promise<Address[]> {
    return (await this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_V13_ABI,
      functionName: 'lpSliceTokens',
    })) as Address[];
  }

  private async slice(vaultAddress: Address, token: Address): Promise<readonly [bigint, bigint]> {
    return (await this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_V13_ABI,
      functionName: 'lpSlice',
      args: [token],
    })) as readonly [bigint, bigint];
  }
}
