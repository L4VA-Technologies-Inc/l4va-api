import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import {
  DistributedRewardRes,
  DistributedRewardTimelinePointRes,
  PendingRewardRes,
  StakeAnalyticsRes,
  StakeTokenAnalyticsRes,
  StakeTransactionStatsRes,
  TopStakerRes,
} from './dto/stake-analytics.res';

import { StakingStatus, TokenStakingPosition, TokenType } from '@/database/tokenStakingPosition.entity';
import { Transaction } from '@/database/transaction.entity';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

type TokenMeta = { decimals: number; type: TokenType | null };

function toHumanAmount(raw: bigint, decimals: number): number {
  return Number(raw) / Math.pow(10, decimals);
}

@Injectable()
export class StakeAdminService {
  private readonly APY: number;
  private readonly APY_SCALED: bigint;
  private readonly TOKEN_DECIMALS = 4;
  private readonly tokenRegistry: Map<string, TokenMeta>;
  private readonly adminAddress: string;
  private readonly blockfrost: BlockFrostAPI;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(TokenStakingPosition)
    private readonly tokenStakingPositionRepository: Repository<TokenStakingPosition>
  ) {
    const apyPercentRaw = this.configService.get<string>('STAKING_APY') ?? '8';
    const apyPercent = Number.parseFloat(apyPercentRaw);
    if (!Number.isFinite(apyPercent) || apyPercent < 0 || apyPercent > 100) {
      throw new Error(`Invalid STAKING_APY: expected a number between 0 and 100 (percent), got "${apyPercentRaw}"`);
    }
    this.APY = apyPercent / 100;
    this.APY_SCALED = BigInt(Math.round(this.APY * 1e12));
    this.tokenRegistry = this.buildTokenRegistry();
    this.adminAddress = this.configService.getOrThrow<string>('ADMIN_ADDRESS');
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.getOrThrow<string>('BLOCKFROST_API_KEY'),
    });
  }

  private buildTokenRegistry(): Map<string, TokenMeta> {
    const map = new Map<string, TokenMeta>();

    const vlrmPolicy = this.configService.get<string>('VLRM_POLICY_ID')?.toLowerCase();
    const vlrmName = this.configService.get<string>('VLRM_HEX_ASSET_NAME')?.toLowerCase() ?? '';
    const vlrmDecimals = parseInt(this.configService.get<string>('VLRM_DECIMALS') ?? '4', 10);
    if (vlrmPolicy) {
      map.set(`${vlrmPolicy}${vlrmName}`, {
        decimals: Number.isFinite(vlrmDecimals) ? vlrmDecimals : 4,
        type: TokenType.VLRM,
      });
    }

    const l4vaPolicy = this.configService.get<string>('L4VA_POLICY_ID')?.toLowerCase();
    const l4vaName = this.configService.get<string>('L4VA_ASSET_NAME')?.toLowerCase() ?? '';
    const l4vaDecimals = parseInt(this.configService.get<string>('L4VA_DECIMALS') ?? '3', 10);
    if (l4vaPolicy) {
      map.set(`${l4vaPolicy}${l4vaName}`, {
        decimals: Number.isFinite(l4vaDecimals) ? l4vaDecimals : 3,
        type: TokenType.L4VA,
      });
    }

    return map;
  }

  private getDecimalsForUnit(unit: string): number {
    return this.tokenRegistry.get(unit.toLowerCase())?.decimals ?? this.TOKEN_DECIMALS;
  }

  private getUnitForTokenType(tokenType: TokenType): string {
    for (const [unit, meta] of this.tokenRegistry) {
      if (meta.type === tokenType) return unit;
    }
    return '';
  }

  private async getAdminTokenBalances(): Promise<{
    l4vaRaw: string;
    l4vaHuman: number;
    vlrmRaw: string;
    vlrmHuman: number;
  }> {
    const l4vaUnit = this.getUnitForTokenType(TokenType.L4VA);
    const vlrmUnit = this.getUnitForTokenType(TokenType.VLRM);
    const l4vaDecimals = this.getDecimalsForUnit(l4vaUnit);
    const vlrmDecimals = this.getDecimalsForUnit(vlrmUnit);

    const addressInfo = await this.blockfrost.addresses(this.adminAddress);
    const amountByUnit = new Map<string, bigint>(
      (addressInfo.amount ?? []).map(entry => [entry.unit.toLowerCase(), BigInt(entry.quantity)])
    );

    const l4vaRaw = l4vaUnit ? (amountByUnit.get(l4vaUnit.toLowerCase()) ?? 0n) : 0n;
    const vlrmRaw = vlrmUnit ? (amountByUnit.get(vlrmUnit.toLowerCase()) ?? 0n) : 0n;

    return {
      l4vaRaw: l4vaRaw.toString(),
      l4vaHuman: toHumanAmount(l4vaRaw, l4vaDecimals),
      vlrmRaw: vlrmRaw.toString(),
      vlrmHuman: toHumanAmount(vlrmRaw, vlrmDecimals),
    };
  }

  async getStakingAnalytics(): Promise<StakeAnalyticsRes> {
    const MS_IN_YEAR = 365n * 24n * 60n * 60n * 1000n;
    const APY_SCALE = 10n ** 12n;
    const now = Date.now();

    const stakeTypes = [
      TransactionType.stake,
      TransactionType.unstake,
      TransactionType.harvest,
      TransactionType.compound,
    ];

    const [activePositions, closedPositions, allTimeStakersResult, adminWalletBalances] = await Promise.all([
      this.tokenStakingPositionRepository.find({
        where: { status: StakingStatus.ACTIVE },
        relations: ['stake_transaction', 'user'],
        order: { created_at: 'ASC' },
      }),
      this.tokenStakingPositionRepository.find({
        where: { status: StakingStatus.CLOSED },
        relations: ['stake_transaction', 'unstake_transaction'],
      }),
      this.tokenStakingPositionRepository
        .createQueryBuilder('p')
        .select('COUNT(DISTINCT p.user_id)', 'count')
        .getRawOne<{ count: string }>(),
      this.getAdminTokenBalances(),
    ]);

    const uniqueAllTimeStakers = parseInt(allTimeStakersResult?.count ?? '0', 10);
    const activeStakerIds = new Set(activePositions.map(p => p.user_id));

    type TokenAgg = {
      activePositions: number;
      stakerIds: Set<string>;
      totalDepositRaw: bigint;
      totalRewardRaw: bigint;
      totalPayoutRaw: bigint;
      durations: number[];
      stakedAtTimestamps: number[];
    };

    type UserTokenKey = `${string}:${TokenType}`;
    type UserTokenAgg = {
      userId: string;
      walletAddress: string;
      tokenType: TokenType;
      totalDepositRaw: bigint;
      positionCount: number;
    };

    const tokenAggMap = new Map<TokenType, TokenAgg>();
    const userTokenMap = new Map<UserTokenKey, UserTokenAgg>();

    for (const pos of activePositions) {
      const { token_type: tokenType, user_id } = pos;
      const txMeta = pos.stake_transaction?.metadata ?? {};
      const stakedAt = Number(txMeta.staked_at ?? 0);
      const amount = BigInt(pos.amount);

      let reward = 0n;
      if (stakedAt > 0) {
        const elapsed = BigInt(Math.max(0, now - stakedAt));
        reward = (amount * this.APY_SCALED * elapsed) / (MS_IN_YEAR * APY_SCALE);
      }

      if (!tokenAggMap.has(tokenType)) {
        tokenAggMap.set(tokenType, {
          activePositions: 0,
          stakerIds: new Set(),
          totalDepositRaw: 0n,
          totalRewardRaw: 0n,
          totalPayoutRaw: 0n,
          durations: [],
          stakedAtTimestamps: [],
        });
      }

      const agg = tokenAggMap.get(tokenType)!;
      agg.activePositions += 1;
      agg.stakerIds.add(user_id);
      agg.totalDepositRaw += amount;
      agg.totalRewardRaw += reward;
      agg.totalPayoutRaw += amount + reward;
      if (stakedAt > 0) {
        agg.durations.push(now - stakedAt);
        agg.stakedAtTimestamps.push(stakedAt);
      }

      const userTokenKey: UserTokenKey = `${user_id}:${tokenType}`;
      if (!userTokenMap.has(userTokenKey)) {
        userTokenMap.set(userTokenKey, {
          userId: user_id,
          walletAddress: pos.user?.address ?? '',
          tokenType,
          totalDepositRaw: 0n,
          positionCount: 0,
        });
      }
      const userAgg = userTokenMap.get(userTokenKey)!;
      userAgg.totalDepositRaw += amount;
      userAgg.positionCount += 1;
    }

    const byToken: StakeTokenAnalyticsRes[] = Array.from(tokenAggMap.entries()).map(([tokenType, agg]) => {
      const unit = this.getUnitForTokenType(tokenType);
      const decimals = this.getDecimalsForUnit(unit);
      const avgDuration =
        agg.durations.length > 0 ? Math.round(agg.durations.reduce((a, b) => a + b, 0) / agg.durations.length) : 0;

      return {
        tokenType,
        activePositionsCount: agg.activePositions,
        uniqueStakers: agg.stakerIds.size,
        totalDepositedRaw: agg.totalDepositRaw.toString(),
        totalDepositedHuman: toHumanAmount(agg.totalDepositRaw, decimals),
        totalEstimatedRewardRaw: agg.totalRewardRaw.toString(),
        totalEstimatedRewardHuman: toHumanAmount(agg.totalRewardRaw, decimals),
        totalEstimatedPayoutRaw: agg.totalPayoutRaw.toString(),
        totalEstimatedPayoutHuman: toHumanAmount(agg.totalPayoutRaw, decimals),
        averageStakingDurationMs: avgDuration,
        oldestPositionStakedAt: agg.stakedAtTimestamps.length > 0 ? Math.min(...agg.stakedAtTimestamps) : null,
        newestPositionStakedAt: agg.stakedAtTimestamps.length > 0 ? Math.max(...agg.stakedAtTimestamps) : null,
      };
    });

    const totalPendingRewards: PendingRewardRes[] = byToken.map(t => ({
      tokenType: t.tokenType,
      amountRaw: t.totalEstimatedRewardRaw,
      amountHuman: t.totalEstimatedRewardHuman,
    }));

    const distributedRewardByToken = new Map<TokenType, bigint>();
    const distributedRewardByDateAndToken = new Map<string, bigint>();
    for (const pos of closedPositions) {
      const tokenType = pos.token_type;
      const txMeta = pos.stake_transaction?.metadata ?? {};
      const stakedAt = Number(txMeta.staked_at ?? 0);
      if (stakedAt <= 0) continue;

      const closedAt =
        pos.unstake_transaction?.created_at?.getTime() ?? pos.unstake_transaction?.updated_at?.getTime() ?? now;
      const elapsed = BigInt(Math.max(0, closedAt - stakedAt));
      const amount = BigInt(pos.amount);
      const reward = (amount * this.APY_SCALED * elapsed) / (MS_IN_YEAR * APY_SCALE);
      distributedRewardByToken.set(tokenType, (distributedRewardByToken.get(tokenType) ?? 0n) + reward);

      const date = new Date(closedAt).toISOString().slice(0, 10);
      const dateTokenKey = `${date}|${tokenType}`;
      distributedRewardByDateAndToken.set(
        dateTokenKey,
        (distributedRewardByDateAndToken.get(dateTokenKey) ?? 0n) + reward
      );
    }

    const registeredTokenTypes = new Set<TokenType>();
    for (const meta of this.tokenRegistry.values()) {
      if (meta.type) registeredTokenTypes.add(meta.type);
    }
    for (const tokenType of distributedRewardByToken.keys()) {
      registeredTokenTypes.add(tokenType);
    }

    const totalDistributedRewardsAllTime: DistributedRewardRes[] = Array.from(registeredTokenTypes).map(tokenType => {
      const amountRaw = distributedRewardByToken.get(tokenType) ?? 0n;
      const unit = this.getUnitForTokenType(tokenType);
      const decimals = this.getDecimalsForUnit(unit);

      return {
        tokenType,
        amountRaw: amountRaw.toString(),
        amountHuman: toHumanAmount(amountRaw, decimals),
      };
    });

    const distributedRewardsTimeline: DistributedRewardTimelinePointRes[] = Array.from(
      distributedRewardByDateAndToken.entries()
    )
      .map(([key, amountRaw]) => {
        const [date, tokenTypeValue] = key.split('|');
        const tokenType = tokenTypeValue as TokenType;
        const unit = this.getUnitForTokenType(tokenType);
        const decimals = this.getDecimalsForUnit(unit);
        return {
          date,
          tokenType,
          amountRaw: amountRaw.toString(),
          amountHuman: toHumanAmount(amountRaw, decimals),
        };
      })
      .sort((a, b) => {
        if (a.date === b.date) return a.tokenType.localeCompare(b.tokenType);
        return a.date.localeCompare(b.date);
      });

    const topStakers: TopStakerRes[] = Array.from(userTokenMap.values())
      .sort((a, b) => (b.totalDepositRaw > a.totalDepositRaw ? 1 : b.totalDepositRaw < a.totalDepositRaw ? -1 : 0))
      .slice(0, 20)
      .map(entry => {
        const unit = this.getUnitForTokenType(entry.tokenType);
        const decimals = this.getDecimalsForUnit(unit);
        return {
          userId: entry.userId,
          walletAddress: entry.walletAddress,
          tokenType: entry.tokenType,
          totalDepositedRaw: entry.totalDepositRaw.toString(),
          totalDepositedHuman: toHumanAmount(entry.totalDepositRaw, decimals),
          positionCount: entry.positionCount,
        };
      });

    const txCountsByType = await Promise.all(
      stakeTypes.map(t => this.transactionRepository.count({ where: { type: t } }))
    );
    const byType: Record<string, number> = Object.fromEntries(stakeTypes.map((t, i) => [t, txCountsByType[i]]));

    const allStatuses = Object.values(TransactionStatus);
    const txCountsByStatus = await Promise.all(
      allStatuses.map(s => this.transactionRepository.count({ where: { type: In(stakeTypes), status: s } }))
    );
    const byStatus: Record<string, number> = Object.fromEntries(allStatuses.map((s, i) => [s, txCountsByStatus[i]]));

    const transactions: StakeTransactionStatsRes = {
      byType,
      byStatus,
      total: txCountsByType.reduce((a, b) => a + b, 0),
    };

    return {
      generatedAt: now,
      apy: this.APY * 100,
      totalActivePositions: activePositions.length,
      totalClosedPositions: closedPositions.length,
      uniqueActiveStakers: activeStakerIds.size,
      uniqueAllTimeStakers,
      byToken,
      totalPendingRewards,
      totalDistributedRewardsAllTime,
      distributedRewardsTimeline,
      transactions,
      topStakers,
      adminWalletBalances,
    };
  }
}
