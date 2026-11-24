/**
 * Auto-rebalance schedule for index-weighted vaults. Pure functions so they can
 * be tested without the Nest container; IndexVaultService feeds in the admin
 * settings.
 */
import type { IndexConfig, IndexScheduleInput } from '../../../types/index-vault.types';

export const MAX_REBALANCE_CADENCE_DAYS = 365;
const DAY_MS = 86_400_000;

export interface ScheduleLimits {
  minCadenceDays: number;
  defaultCadenceDays: number;
}

export interface ResolvedSchedule {
  autoRebalance: boolean;
  rebalanceCadenceDays: number | null;
}

/**
 * Fill in the auto-rebalance fields. Omitted fields keep the previous value. A new
 * vault defaults to on at the admin default cadence. A config created before this
 * feature (no `autoRebalance` key) counts as off. Returns an error message instead
 * of throwing so the caller picks the exception type.
 */
export function resolveSchedule(
  input: IndexScheduleInput | undefined,
  previous: IndexConfig | null | undefined,
  limits: ScheduleLimits
): ResolvedSchedule | { error: string } {
  const autoRebalance = input?.autoRebalance ?? previous?.autoRebalance ?? !previous;
  if (!autoRebalance) {
    return {
      autoRebalance,
      rebalanceCadenceDays: input?.rebalanceCadenceDays ?? previous?.rebalanceCadenceDays ?? null,
    };
  }
  const cadence = input?.rebalanceCadenceDays ?? previous?.rebalanceCadenceDays ?? limits.defaultCadenceDays;
  if (!Number.isInteger(cadence) || cadence < limits.minCadenceDays || cadence > MAX_REBALANCE_CADENCE_DAYS) {
    return {
      error: `Rebalance cadence must be a whole number of days between ${limits.minCadenceDays} and ${MAX_REBALANCE_CADENCE_DAYS}`,
    };
  }
  return { autoRebalance, rebalanceCadenceDays: cadence };
}

/** from + cadence + a random 0..jitter hours (minute resolution), so the run time cannot be front-run. */
export function computeNextRebalanceAt(
  cadenceDays: number | null,
  jitterHours: number,
  from: number,
  rng: () => number = Math.random
): string | null {
  if (!cadenceDays) return null;
  const jitterMinutes = Math.floor(rng() * (Math.round(jitterHours * 60) + 1));
  return new Date(from + cadenceDays * DAY_MS + jitterMinutes * 60_000).toISOString();
}

/**
 * The next run time stored with a new config. If the schedule changed, the clock
 * restarts. If it is unchanged, the pending run is kept. Turning auto-rebalance off
 * clears it. null means "not scheduled yet": the keeper starts the clock once the
 * basket has been bought.
 */
export function nextRunAfterConfigChange(
  schedule: ResolvedSchedule,
  previous: IndexConfig | null | undefined,
  restart: (cadenceDays: number | null) => string | null
): string | null {
  if (!schedule.autoRebalance) return null;
  const current = previous?.nextRebalanceAt ?? null;
  const changed =
    !!previous &&
    (schedule.autoRebalance !== (previous.autoRebalance ?? false) ||
      schedule.rebalanceCadenceDays !== (previous.rebalanceCadenceDays ?? null));
  return changed && current ? restart(schedule.rebalanceCadenceDays) : current;
}
