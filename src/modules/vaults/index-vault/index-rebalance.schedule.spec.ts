import { describe, expect, it } from '@jest/globals';

import type { IndexConfig } from '../../../types/index-vault.types';

import { computeNextRebalanceAt, nextRunAfterConfigChange, resolveSchedule } from './index-rebalance.schedule';

const limits = { minCadenceDays: 7, defaultCadenceDays: 30 };
const DAY = 86_400_000;

const previous = (over: Partial<IndexConfig> = {}): IndexConfig => ({
  targets: [{ assetAddress: '0xabc', symbol: 'AAA', decimals: 18, weightBps: 10_000 }],
  reserveBps: 1000,
  driftToleranceBps: 200,
  slippageBps: 100,
  version: 1,
  updatedAt: '2026-11-01T00:00:00.000Z',
  autoRebalance: true,
  rebalanceCadenceDays: 30,
  nextRebalanceAt: '2026-12-01T00:00:00.000Z',
  ...over,
});

describe('resolveSchedule', () => {
  it('defaults a new vault to on at the admin default cadence', () => {
    expect(resolveSchedule(undefined, null, limits)).toEqual({ autoRebalance: true, rebalanceCadenceDays: 30 });
  });

  it('keeps the previous schedule when the input omits it', () => {
    expect(resolveSchedule({}, previous({ rebalanceCadenceDays: 10 }), limits)).toEqual({
      autoRebalance: true,
      rebalanceCadenceDays: 10,
    });
  });

  it('treats configs created before the feature as off', () => {
    const legacy = previous({ autoRebalance: undefined, rebalanceCadenceDays: undefined });
    expect(resolveSchedule({}, legacy, limits)).toEqual({ autoRebalance: false, rebalanceCadenceDays: null });
  });

  it('rejects a cadence below the admin minimum or above a year', () => {
    expect(resolveSchedule({ rebalanceCadenceDays: 3 }, null, limits)).toHaveProperty('error');
    expect(resolveSchedule({ rebalanceCadenceDays: 400 }, null, limits)).toHaveProperty('error');
  });

  it('does not validate the cadence when auto-rebalance is off', () => {
    expect(resolveSchedule({ autoRebalance: false, rebalanceCadenceDays: 3 }, null, limits)).toEqual({
      autoRebalance: false,
      rebalanceCadenceDays: 3,
    });
  });
});

describe('computeNextRebalanceAt', () => {
  const from = Date.UTC(2026, 10, 8);
  const offset = (rng: () => number): number => new Date(computeNextRebalanceAt(30, 6, from, rng)!).getTime() - from;

  it('adds exactly the cadence at the low end of the jitter', () => {
    expect(offset(() => 0)).toBe(30 * DAY);
  });

  it('adds at most the jitter window at the high end', () => {
    expect(offset(() => 0.999999)).toBe(30 * DAY + 6 * 3_600_000);
  });

  it('returns null without a cadence', () => {
    expect(computeNextRebalanceAt(null, 6, from)).toBeNull();
  });
});

describe('nextRunAfterConfigChange', () => {
  const restart = (): string => 'RESTARTED';

  it('keeps the pending run when the schedule is unchanged', () => {
    const p = previous();
    expect(nextRunAfterConfigChange({ autoRebalance: true, rebalanceCadenceDays: 30 }, p, restart)).toBe(
      p.nextRebalanceAt
    );
  });

  it('restarts the clock when the cadence changes', () => {
    expect(nextRunAfterConfigChange({ autoRebalance: true, rebalanceCadenceDays: 7 }, previous(), restart)).toBe(
      'RESTARTED'
    );
  });

  it('clears the run when auto-rebalance is turned off', () => {
    expect(
      nextRunAfterConfigChange({ autoRebalance: false, rebalanceCadenceDays: 30 }, previous(), restart)
    ).toBeNull();
  });

  it('leaves a vault without a started clock unscheduled (the keeper starts it after the first buy)', () => {
    expect(nextRunAfterConfigChange({ autoRebalance: true, rebalanceCadenceDays: 30 }, null, restart)).toBeNull();
    const p = previous({ nextRebalanceAt: null });
    expect(nextRunAfterConfigChange({ autoRebalance: true, rebalanceCadenceDays: 7 }, p, restart)).toBeNull();
  });
});
