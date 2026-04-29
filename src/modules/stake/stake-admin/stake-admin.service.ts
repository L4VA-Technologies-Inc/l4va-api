import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  DistributedRewardRes,
  DistributedRewardTimelinePointRes,
  PendingRewardRes,
  StakeAnalyticsRes,
  StakeTokenAnalyticsRes,
  StakeTransactionStatsRes,
  TopStakerRes,
} from './dto/stake-analytics.res';

import { buildStakeTokenRegistry, type TokenMeta } from '@/common/cardano/token-registry';
import { StakingStatus, TokenStakingPosition, TokenType } from '@/database/tokenStakingPosition.entity';
import { Transaction } from '@/database/transaction.entity';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

function toHumanAmount(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const absoluteRaw = negative ? -raw : raw;

  if (decimals === 0) {
    return `${negative ? '-' : ''}${absoluteRaw.toString()}`;
  }

  const scale = 10n ** BigInt(decimals);
  const whole = absoluteRaw / scale;
  const fraction = absoluteRaw % scale;
  const fractionString = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');

  if (fractionString.length === 0) {
    return `${negative ? '-' : ''}${whole.toString()}`;
  }

  return `${negative ? '-' : ''}${whole.toString()}.${fractionString}`;
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
    this.tokenRegistry = buildStakeTokenRegistry(this.configService);
    this.adminAddress = this.configService.getOrThrow<string>('ADMIN_ADDRESS');
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.getOrThrow<string>('BLOCKFROST_API_KEY'),
    });
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
    l4vaConfigured: boolean;
    l4vaRaw: string;
    l4vaHuman: string;
    vlrmConfigured: boolean;
    vlrmRaw: string;
    vlrmHuman: string;
  }> {
    const l4vaUnit = this.getUnitForTokenType(TokenType.L4VA);
    const vlrmUnit = this.getUnitForTokenType(TokenType.VLRM);
    const l4vaConfigured = l4vaUnit.length > 0;
    const vlrmConfigured = vlrmUnit.length > 0;
    const l4vaDecimals = l4vaConfigured ? this.getDecimalsForUnit(l4vaUnit) : this.TOKEN_DECIMALS;
    const vlrmDecimals = vlrmConfigured ? this.getDecimalsForUnit(vlrmUnit) : this.TOKEN_DECIMALS;

    const addressInfo = await this.blockfrost.addresses(this.adminAddress);
    const amountByUnit = new Map<string, bigint>(
      (addressInfo.amount ?? []).map(entry => [entry.unit.toLowerCase(), BigInt(entry.quantity)])
    );

    const l4vaRaw = l4vaUnit ? (amountByUnit.get(l4vaUnit.toLowerCase()) ?? 0n) : 0n;
    const vlrmRaw = vlrmUnit ? (amountByUnit.get(vlrmUnit.toLowerCase()) ?? 0n) : 0n;

    return {
      l4vaConfigured,
      l4vaRaw: l4vaRaw.toString(),
      l4vaHuman: toHumanAmount(l4vaRaw, l4vaDecimals),
      vlrmConfigured,
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

    type ActivePositionRow = {
      userId: string;
      tokenType: TokenType;
      amount: string;
      walletAddress: string | null;
      stakeMetadata: { staked_at?: number } | null;
    };
    type ClosedPositionRow = {
      tokenType: TokenType;
      amount: string;
      stakeMetadata: { staked_at?: number } | null;
      unstakeCreatedAt: Date | string | null;
      unstakeUpdatedAt: Date | string | null;
    };

    const [activePositions, closedPositions, allTimeStakersResult, adminWalletBalances] = await Promise.all([
      this.tokenStakingPositionRepository
        .createQueryBuilder('p')
        .leftJoin('p.stake_transaction', 'stakeTx')
        .leftJoin('p.user', 'u')
        .select('p.user_id', 'userId')
        .addSelect('p.token_type', 'tokenType')
        .addSelect('p.amount', 'amount')
        .addSelect('u.address', 'walletAddress')
        .addSelect('stakeTx.metadata', 'stakeMetadata')
        .where('p.status = :status', { status: StakingStatus.ACTIVE })
        .orderBy('p.created_at', 'ASC')
        .getRawMany<ActivePositionRow>(),
      this.tokenStakingPositionRepository
        .createQueryBuilder('p')
        .leftJoin('p.stake_transaction', 'stakeTx')
        .leftJoin('p.unstake_transaction', 'unstakeTx')
        .select('p.token_type', 'tokenType')
        .addSelect('p.amount', 'amount')
        .addSelect('stakeTx.metadata', 'stakeMetadata')
        .addSelect('unstakeTx.created_at', 'unstakeCreatedAt')
        .addSelect('unstakeTx.updated_at', 'unstakeUpdatedAt')
        .where('p.status = :status', { status: StakingStatus.CLOSED })
        .getRawMany<ClosedPositionRow>(),
      this.tokenStakingPositionRepository
        .createQueryBuilder('p')
        .select('COUNT(DISTINCT p.user_id)', 'count')
        .getRawOne<{ count: string }>(),
      this.getAdminTokenBalances(),
    ]);

    const uniqueAllTimeStakers = parseInt(allTimeStakersResult?.count ?? '0', 10);
    const activeStakerIds = new Set(activePositions.map(p => p.userId));

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
      const tokenType = pos.tokenType;
      const userId = pos.userId;
      const txMeta = pos.stakeMetadata ?? {};
      const stakedAt = Number(txMeta?.staked_at ?? 0);
      const amount = BigInt(pos.amount ?? '0');

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
      agg.stakerIds.add(userId);
      agg.totalDepositRaw += amount;
      agg.totalRewardRaw += reward;
      agg.totalPayoutRaw += amount + reward;
      if (stakedAt > 0) {
        agg.durations.push(now - stakedAt);
        agg.stakedAtTimestamps.push(stakedAt);
      }

      const userTokenKey: UserTokenKey = `${userId}:${tokenType}`;
      if (!userTokenMap.has(userTokenKey)) {
        userTokenMap.set(userTokenKey, {
          userId,
          walletAddress: pos.walletAddress ?? '',
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
      const tokenType = pos.tokenType;
      const txMeta = pos.stakeMetadata ?? {};
      const stakedAt = Number(txMeta?.staked_at ?? 0);
      if (stakedAt <= 0) continue;

      const closedAt = pos.unstakeCreatedAt
        ? new Date(pos.unstakeCreatedAt).getTime()
        : pos.unstakeUpdatedAt
          ? new Date(pos.unstakeUpdatedAt).getTime()
          : now;
      const elapsed = BigInt(Math.max(0, closedAt - stakedAt));
      const amount = BigInt(pos.amount ?? '0');
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

    const txCountsByType = await this.transactionRepository
      .createQueryBuilder('tx')
      .select('tx.type', 'type')
      .addSelect('COUNT(*)', 'count')
      .where('tx.type IN (:...stakeTypes)', { stakeTypes })
      .groupBy('tx.type')
      .getRawMany<{ type: TransactionType; count: string }>();
    const txCountByTypeMap = new Map(txCountsByType.map(row => [row.type, Number(row.count)]));
    const byType: Record<string, number> = Object.fromEntries(
      stakeTypes.map(type => [type, txCountByTypeMap.get(type) ?? 0])
    );

    const allStatuses = Object.values(TransactionStatus);
    const txCountsByStatus = await this.transactionRepository
      .createQueryBuilder('tx')
      .select('tx.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('tx.type IN (:...stakeTypes)', { stakeTypes })
      .groupBy('tx.status')
      .getRawMany<{ status: TransactionStatus; count: string }>();
    const txCountByStatusMap = new Map(txCountsByStatus.map(row => [row.status, Number(row.count)]));
    const byStatus: Record<string, number> = Object.fromEntries(
      allStatuses.map(status => [status, txCountByStatusMap.get(status) ?? 0])
    );

    const transactions: StakeTransactionStatsRes = {
      byType,
      byStatus,
      total: Object.values(byType).reduce((a, b) => a + b, 0),
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
