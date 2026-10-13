import { ConfigService } from '@nestjs/config';

import { TokenType } from '@/database/tokenStakingPosition.entity';

const MS_IN_YEAR = 365n * 24n * 60n * 60n * 1000n;
/** APY is pre-scaled to 12 decimal places for bigint reward arithmetic. */
const APY_SCALE = 10n ** 12n;

export type StakeApy = { percent: number; scaled: bigint };

function parseApyPercent(configService: ConfigService, keys: string[], defaultPercent: number): number {
  for (const key of keys) {
    const raw = configService.get<string>(key);
    if (raw === undefined || raw.trim() === '') continue;
    const percent = Number.parseFloat(raw);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw new Error(`Invalid ${key}: expected a number between 0 and 100 (percent), got "${raw}"`);
    }
    return percent;
  }
  return defaultPercent;
}

/**
 * Per-token staking APY.
 * VLRM: STAKING_APY_VLRM (falls back to legacy STAKING_APY), default 8%.
 * L4VA: STAKING_APY_L4VA, default 5%.
 */
export function buildStakingApyByTokenType(configService: ConfigService): Map<TokenType, StakeApy> {
  const percents: Record<TokenType, number> = {
    [TokenType.VLRM]: parseApyPercent(configService, ['STAKING_APY_VLRM', 'STAKING_APY'], 8),
    [TokenType.L4VA]: parseApyPercent(configService, ['STAKING_APY_L4VA'], 5),
  };

  return new Map(
    Object.entries(percents).map(([tokenType, percent]) => [
      tokenType as TokenType,
      { percent, scaled: BigInt(Math.round((percent / 100) * 1e12)) },
    ])
  );
}

/** Linear (non-compounding) reward accrued on `amount` over `elapsedMs`. */
export function calculateStakeReward(amount: bigint, apyScaled: bigint, elapsedMs: number): bigint {
  const elapsed = BigInt(Math.max(0, Math.floor(elapsedMs)));
  return (amount * apyScaled * elapsed) / (MS_IN_YEAR * APY_SCALE);
}
