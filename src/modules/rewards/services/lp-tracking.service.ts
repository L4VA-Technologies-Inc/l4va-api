import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom } from 'rxjs';
import { Repository } from 'typeorm';

import { RewardLpPosition } from '@/database/rewardLpPosition.entity';
import { Vault } from '@/database/vault.entity';
import { LpPoolType } from '@/types/rewards.types';

interface TapToolsPool {
  exchange: string;
  lpTokenUnit: string;
  onchainID: string;
  tokenA: string;
  tokenALocked: number;
  tokenATicker: string;
  tokenB: string;
  tokenBLocked: number;
  tokenBTicker: string;
}

/**
 * Service for tracking user LP positions across DEXes and calculating LP scores.
 * Uses TapTools API for pool discovery and BlockFrost for balance/supply queries.
 */
@Injectable()
export class LpTrackingService {
  private readonly logger = new Logger(LpTrackingService.name);
  private readonly blockfrost: BlockFrostAPI;
  private readonly TAPTOOLS_API = 'https://openapi.taptools.io/api/v1';

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    @InjectRepository(RewardLpPosition)
    private readonly lpPositionRepo: Repository<RewardLpPosition>,
    @InjectRepository(Vault)
    private readonly vaultRepo: Repository<Vault>
  ) {
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });
  }

  /**
   * Get LP pools for a vault token from TapTools
   */
  async getLpPoolsForVault(vaultTokenUnit: string): Promise<TapToolsPool[]> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<TapToolsPool[]>(`${this.TAPTOOLS_API}/token/pools?unit=${vaultTokenUnit}`)
      );

      const pools = response.data.filter(pool => this.isEligiblePool(pool));

      this.logger.log(`Found ${pools.length} eligible LP pools for vault token ${vaultTokenUnit.slice(0, 10)}...`);

      return pools;
    } catch (error) {
      this.logger.error(`Failed to get LP pools from TapTools: ${error.message}`);
      return [];
    }
  }

  /**
   * Check if pool is eligible (VT/ADA or VT/USDCx)
   */
  private isEligiblePool(pool: TapToolsPool): boolean {
    const isAda = pool.tokenB === '' || pool.tokenBTicker === 'ADA';
    const isUsdcx = pool.tokenBTicker?.toLowerCase() === 'usdcx';

    return isAda || isUsdcx;
  }

  /**
   * Determine pool type from TapTools pool data
   */
  private getPoolType(pool: TapToolsPool): LpPoolType | null {
    const isAda = pool.tokenB === '' || pool.tokenBTicker === 'ADA';
    const isUsdcx = pool.tokenBTicker?.toLowerCase() === 'usdcx';

    if (isAda) {
      return LpPoolType.VT_ADA;
    } else if (isUsdcx) {
      return LpPoolType.VT_USDCX;
    }

    return null;
  }

  /**
   * Calculate LP score for a user on a specific vault
   *
   * Formula:
   * LP_score = (user_lp_tokens / total_lp_supply) × vault_tokens_in_pool × age_factor
   */
  async calculateLpScoreForVault(userAddress: string, vaultId: string): Promise<number> {
    try {
      // Get vault to get token unit
      const vault = await this.vaultRepo.findOne({ where: { id: vaultId } });
      if (!vault || !vault.policy_id || !vault.asset_vault_name) {
        this.logger.warn(`Vault ${vaultId} not found or missing token data`);
        return 0;
      }

      const vaultTokenUnit = vault.policy_id + vault.asset_vault_name;

      // Get LP pools from TapTools
      const pools = await this.getLpPoolsForVault(vaultTokenUnit);
      if (pools.length === 0) {
        return 0;
      }

      // Get user's UTXOs from BlockFrost
      const userUtxos = await this.blockfrost.addressesUtxosAll(userAddress);

      let totalLpScore = 0;

      // For each pool, calculate user's LP contribution
      for (const pool of pools) {
        // Determine pool type
        const poolType = this.getPoolType(pool);
        if (!poolType) {
          continue;
        }

        // Use exchange name directly from TapTools
        const dex = pool.exchange;

        // Find if user holds this LP token
        const lpAsset = userUtxos.flatMap(utxo => utxo.amount).find(amt => amt.unit === pool.lpTokenUnit);

        if (!lpAsset) {
          continue; // User has no LP in this pool
        }

        const userLpTokens = parseInt(lpAsset.quantity);

        // Get LP token total supply from BlockFrost
        const lpTotalSupply = await this.getLpTokenTotalSupply(pool.lpTokenUnit);
        if (lpTotalSupply === 0) {
          this.logger.warn(`LP total supply is 0 for ${pool.lpTokenUnit}`);
          continue;
        }

        // Calculate user's share of vault tokens in the pool
        const vtInPool = pool.tokenALocked;
        const userVtEquivalent = (userLpTokens / lpTotalSupply) * vtInPool;

        // Calculate position age
        const firstDetected = await this.getFirstLpDetection(userAddress, pool.lpTokenUnit);
        const ageSeconds = Math.floor((Date.now() - firstDetected.getTime()) / 1000);
        const ageFactor = this.calculateAgeFactor(ageSeconds);

        // Calculate score: VT equivalent × age factor
        const lpScore = userVtEquivalent * ageFactor;
        totalLpScore += lpScore;

        this.logger.log(
          `User ${userAddress.slice(0, 10)}... LP score in ${pool.exchange}: ${lpScore.toFixed(2)} ` +
            `(VT equiv: ${userVtEquivalent.toFixed(2)}, ` +
            `LP tokens: ${userLpTokens}, ` +
            `age factor: ${ageFactor.toFixed(2)})`
        );

        // Save/update LP position
        await this.upsertLpPosition(
          userAddress,
          vaultId,
          dex,
          poolType,
          userLpTokens,
          vtInPool,
          userVtEquivalent,
          ageSeconds,
          firstDetected
        );
      }

      return totalLpScore;
    } catch (error) {
      this.logger.error(`Failed to calculate LP score for ${userAddress}: ${error.message}`);
      return 0;
    }
  }

  /**
   * Get LP token total supply from BlockFrost
   */
  private async getLpTokenTotalSupply(lpTokenUnit: string): Promise<number> {
    try {
      const assetInfo = await this.blockfrost.assetsById(lpTokenUnit);
      return parseInt(assetInfo.quantity);
    } catch (error) {
      this.logger.error(`Failed to get LP token supply for ${lpTokenUnit}: ${error.message}`);
      return 0;
    }
  }

  /**
   * Get first LP detection timestamp by checking existing DB record or querying blockchain
   */
  private async getFirstLpDetection(userAddress: string, lpTokenUnit: string): Promise<Date> {
    try {
      // Check if we already have a record
      const existingPosition = await this.lpPositionRepo.findOne({
        where: {
          wallet_address: userAddress,
        },
      });

      if (existingPosition && existingPosition.first_detected) {
        return existingPosition.first_detected;
      }

      // Query blockchain for first transaction with this LP token
      const txHistory = await this.blockfrost.addressesTransactionsAll(userAddress, { order: 'asc' });

      for (const tx of txHistory) {
        try {
          const txData = await this.blockfrost.txsUtxos(tx.tx_hash);

          const hasLpToken = txData.outputs.some(output => output.amount.some(amt => amt.unit === lpTokenUnit));

          if (hasLpToken) {
            const txDetails = await this.blockfrost.txs(tx.tx_hash);
            return new Date(txDetails.block_time * 1000);
          }
        } catch {
          continue;
        }
      }

      // If not found, assume now (new LP position)
      return new Date();
    } catch (error) {
      this.logger.warn(`Failed to get first LP detection: ${error.message}, using current time`);
      return new Date();
    }
  }

  /**
   * Calculate age factor with 7-day maturity curve
   *
   * Formula: min(age_seconds / (7 * 24 * 3600), 1.0)
   */
  private calculateAgeFactor(ageSeconds: number): number {
    const sevenDaysInSeconds = 7 * 24 * 3600;
    return Math.min(ageSeconds / sevenDaysInSeconds, 1.0);
  }

  /**
   * Upsert LP position to database
   */
  private async upsertLpPosition(
    walletAddress: string,
    vaultId: string,
    dex: string,
    poolType: LpPoolType,
    lpTokens: number,
    vtInPool: number,
    vtUserEquivalent: number,
    positionAgeSeconds: number,
    firstDetected: Date
  ): Promise<void> {
    try {
      const existing = await this.lpPositionRepo.findOne({
        where: {
          wallet_address: walletAddress,
          vault_id: vaultId,
          pool_type: poolType,
          dex,
        },
      });

      if (existing) {
        existing.lp_tokens = lpTokens;
        existing.vt_in_pool = vtInPool;
        existing.vt_user_equivalent = vtUserEquivalent;
        existing.position_age_seconds = positionAgeSeconds;
        existing.last_updated = new Date();
        await this.lpPositionRepo.save(existing);
      } else {
        const position = this.lpPositionRepo.create({
          wallet_address: walletAddress,
          vault_id: vaultId,
          pool_type: poolType,
          dex,
          lp_tokens: lpTokens,
          vt_in_pool: vtInPool,
          vt_user_equivalent: vtUserEquivalent,
          position_age_seconds: positionAgeSeconds,
          first_detected: firstDetected,
          last_updated: new Date(),
        });

        await this.lpPositionRepo.save(position);
      }

      this.logger.debug(
        `Upserted LP position for ${walletAddress.slice(0, 10)}... ` +
          `in ${dex}/${poolType} (VT equiv: ${vtUserEquivalent.toFixed(2)})`
      );
    } catch (error) {
      this.logger.error(`Failed to upsert LP position: ${error.message}`);
    }
  }

  /**
   * Get user's LP positions for a vault
   */
  async getUserLpPositions(walletAddress: string, vaultId: string): Promise<RewardLpPosition[]> {
    return this.lpPositionRepo.find({
      where: {
        wallet_address: walletAddress,
        vault_id: vaultId,
      },
    });
  }

  /**
   * Refresh LP positions for a user (mark stale positions)
   */
  async refreshUserLpPositions(userAddress: string, vaultId: string): Promise<void> {
    try {
      // Recalculate LP score (which will update positions)
      await this.calculateLpScoreForVault(userAddress, vaultId);

      this.logger.log(`Refreshed LP positions for ${userAddress.slice(0, 10)}... in vault ${vaultId}`);
    } catch (error) {
      this.logger.error(`Failed to refresh LP positions: ${error.message}`);
    }
  }
}
