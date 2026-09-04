import { addMonths } from './month';
import type { Category, Cents, MonthKey } from './types';

export interface AssignmentPatch {
  categoryId: string;
  month: MonthKey;
  amount: Cents;
}

/**
 * A goal to propose for a category that has none: the most frequent non-zero
 * amount assigned to it in the last twelve months including the current one;
 * ties go to the most recent. Null when nothing was assigned.
 */
export function suggestGoal(assigned: Map<MonthKey, Cents> | undefined, currentMonth: MonthKey): Cents | null {
  if (!assigned) return null;
  const from = addMonths(currentMonth, -11);
  const tally = new Map<Cents, { count: number; latest: MonthKey }>();
  for (const [m, amount] of assigned) {
    if (!amount || m < from || m > currentMonth) continue;
    const t = tally.get(amount) ?? { count: 0, latest: m };
    t.count++;
    if (m > t.latest) t.latest = m;
    tally.set(amount, t);
  }
  let best: { amount: Cents; count: number; latest: MonthKey } | null = null;
  for (const [amount, t] of tally) {
    if (!best || t.count > best.count || (t.count === best.count && t.latest > best.latest)) best = { amount, ...t };
  }
  return best?.amount ?? null;
}

/** Patches that bring every visible category with assigned < goal up to its goal, and what that costs. */
export function fillPatches(categories: Category[], assignedOf: (categoryId: string) => Cents, month: MonthKey): { patches: AssignmentPatch[]; total: Cents } {
  const patches: AssignmentPatch[] = [];
  let total = 0;
  for (const c of categories) {
    if (c.deleted || c.hidden || c.goal <= 0) continue;
    const assigned = assignedOf(c.id);
    if (assigned >= c.goal) continue;
    patches.push({ categoryId: c.id, month, amount: c.goal });
    total += c.goal - assigned;
  }
  return { patches, total };
}
