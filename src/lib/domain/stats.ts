import { roundHalfAway } from './money';
import { addMonths, maxMonth, monthsBetween } from './month';
import type { Cents, MonthKey } from './types';

export interface CategoryStats {
  /** Average monthly activity from the category's first month through the last complete month. */
  allTimeAvg: Cents | null;
  /** Average over the last twelve complete months, or fewer if the category is younger. */
  trailing12Avg: Cents | null;
  /** Activity in the last complete month. */
  lastMonth: Cents;
  firstMonth: MonthKey | null;
}

/**
 * Spending stats for one category from its activity by month. The current
 * month is never included (it is incomplete); a window divides by the months
 * the category has existed inside it, so a young category is not diluted by
 * months before it existed.
 */
export function categoryStats(activity: Map<MonthKey, Cents> | undefined, currentMonth: MonthKey): CategoryStats {
  const lastComplete = addMonths(currentMonth, -1);
  const lastMonth = activity?.get(lastComplete) ?? 0;
  const months = activity ? [...activity.keys()].filter((m) => m <= lastComplete).sort() : [];
  const firstMonth = months[0] ?? null;
  if (!firstMonth || !activity) return { allTimeAvg: null, trailing12Avg: null, lastMonth, firstMonth: null };
  const avg = (from: MonthKey): Cents => {
    const span = monthsBetween(from, lastComplete);
    const sum = span.reduce((s, m) => s + (activity.get(m) ?? 0), 0);
    return roundHalfAway(sum / Math.max(1, span.length));
  };
  return {
    allTimeAvg: avg(firstMonth),
    trailing12Avg: avg(maxMonth(firstMonth, addMonths(lastComplete, -11))),
    lastMonth,
    firstMonth,
  };
}
