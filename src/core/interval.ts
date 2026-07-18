export type IntervalUnit = 'once' | 'day' | 'week' | 'month' | 'year';

export interface Interval {
  unit: IntervalUnit;
  /** Number of units per billing period; defaults to 1. `{ unit: 'month', count: 3 }` = quarterly. */
  count?: number;
}

/**
 * Average calendar durations.
 *
 * These are intentionally fixed averages rather than real calendar arithmetic: the
 * insights engine does *rate* math (is annual cheaper than monthly x12?), not invoice
 * scheduling. Fixed averages keep comparisons deterministic and independent of the
 * quote date.
 */
const UNIT_DAYS: Record<Exclude<IntervalUnit, 'once'>, number> = {
  day: 1,
  week: 7,
  month: 30.436875,
  year: 365.2425,
};

export const DEFAULT_INTERVAL: Interval = { unit: 'year', count: 1 };

export function intervalCount (interval: Interval): number {
  return interval.count ?? 1;
}

/** Duration of a single billing period, in days. `once` has no duration. */
export function intervalDays (interval: Interval): number {
  if (interval.unit === 'once') return Infinity;
  return UNIT_DAYS[interval.unit] * intervalCount(interval);
}

/** Duration of the whole purchase (interval x term), in days. */
export function durationDays (interval: Interval, term: number): number {
  const per = intervalDays(interval);
  if (!Number.isFinite(per)) return Infinity;
  return per * term;
}

export function sameInterval (a: Interval, b: Interval): boolean {
  return a.unit === b.unit && intervalCount(a) === intervalCount(b);
}

export function normalizeInterval (interval: Interval | IntervalUnit | undefined, fallback: Interval = DEFAULT_INTERVAL): Interval {
  if (interval === undefined) return fallback;
  if (typeof interval === 'string') return { unit: interval, count: 1 };
  return { unit: interval.unit, count: intervalCount(interval) };
}

export function formatInterval (interval: Interval): string {
  if (interval.unit === 'once') return 'one-time';
  const count = intervalCount(interval);
  return count === 1 ? interval.unit : `${count} ${interval.unit}s`;
}
