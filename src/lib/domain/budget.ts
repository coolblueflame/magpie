import { accountBalances, lineEffect, needsCategory } from './ledger';
import { maxMonth, minMonth, monthOf, monthsBetween } from './month';
import type { Account, Assignment, Category, Cents, MonthKey, Transaction, YnabHistory } from './types';

export interface BudgetInput {
  accounts: Account[];
  categories: Category[];
  assignments: Assignment[];
  transactions: Transaction[];
  history: YnabHistory[];
  cutoverMonth?: MonthKey;
  currentMonth: MonthKey;
}

export interface CategoryMonth {
  categoryId: string;
  month: MonthKey;
  assigned: Cents;
  activity: Cents;
  available: Cents;
}

export interface BudgetMonth {
  month: MonthKey;
  rows: Map<string, CategoryMonth>;
  /** Ready to Assign, one global number (spec §4.2). */
  rta: Cents;
  /** Lines on `new` transactions that touch the budget but have no category yet. */
  uncategorised: Cents;
  onBudgetTotal: Cents;
  /** The later of the current month and the last month anything is assigned to. */
  horizon: MonthKey;
}

const key = (categoryId: string, month: MonthKey) => `${categoryId}|${month}`;

/**
 * Everything the budget screen shows for one month, derived from rows.
 *
 *   available(c, m) = m < cutover ? history : available(c, m-1) + assigned + activity
 *   RTA = Σ on-budget balances − Σ available(c, horizon) − uncategorised
 *
 * Availability walks month by month from the start month so negatives carry;
 * before cutover the YNAB numbers are shown as they were. With no cutover
 * (nothing imported yet) the walk starts at the earliest month with any row.
 */
export function computeBudget(input: BudgetInput, month: MonthKey): BudgetMonth {
  const accountsById = new Map(input.accounts.map((a) => [a.id, a]));

  const activity = new Map<string, Cents>();
  let uncategorised = 0;
  let earliest: MonthKey | undefined;
  for (const tx of input.transactions) {
    if (tx.deleted) continue;
    const own = accountsById.get(tx.accountId);
    if (!own) continue;
    const m = monthOf(tx.date);
    for (const line of tx.lines) {
      const far = line.transferAccountId ? accountsById.get(line.transferAccountId) : undefined;
      if (!needsCategory(line, own, far)) continue;
      const effect = lineEffect(line, own, far);
      if (line.categoryId) {
        const k = key(line.categoryId, m);
        activity.set(k, (activity.get(k) ?? 0) + effect);
        earliest = earliest ? minMonth(earliest, m) : m;
      } else {
        uncategorised += effect;
      }
    }
  }

  const assigned = new Map<string, Cents>();
  let lastAssigned: MonthKey | undefined;
  for (const a of input.assignments) {
    if (a.deleted) continue;
    assigned.set(key(a.categoryId, a.month), a.amount);
    lastAssigned = lastAssigned ? maxMonth(lastAssigned, a.month) : a.month;
    earliest = earliest ? minMonth(earliest, a.month) : a.month;
  }

  const history = new Map<string, YnabHistory>();
  for (const h of input.history) if (!h.deleted) history.set(key(h.categoryId, h.month), h);

  const horizon = lastAssigned ? maxMonth(input.currentMonth, lastAssigned) : input.currentMonth;
  const start = input.cutoverMonth ?? earliest ?? month;
  const end = maxMonth(month, horizon);

  const rows = new Map<string, CategoryMonth>();
  let sumAtHorizon = 0;
  for (const c of input.categories) {
    if (c.deleted) continue;
    if (input.cutoverMonth && month < input.cutoverMonth) {
      const h = history.get(key(c.id, month));
      rows.set(c.id, { categoryId: c.id, month, assigned: h?.assigned ?? 0, activity: h?.activity ?? 0, available: h?.available ?? 0 });
    }
    let available = input.cutoverMonth ? (c.carriedIn ?? 0) : 0;
    for (const m of monthsBetween(start, end)) {
      const asg = assigned.get(key(c.id, m)) ?? 0;
      const act = activity.get(key(c.id, m)) ?? 0;
      available += asg + act;
      if (m === month && !rows.has(c.id)) rows.set(c.id, { categoryId: c.id, month, assigned: asg, activity: act, available });
      if (m === horizon) sumAtHorizon += available;
    }
    if (!rows.has(c.id)) rows.set(c.id, { categoryId: c.id, month, assigned: 0, activity: 0, available: 0 });
  }

  let onBudgetTotal = 0;
  for (const [id, b] of accountBalances(input.accounts, input.transactions)) {
    if (accountsById.get(id)?.onBudget) onBudgetTotal += b.working;
  }

  return { month, rows, rta: onBudgetTotal - sumAtHorizon - uncategorised, uncategorised, onBudgetTotal, horizon };
}
