/**
 * Series for the charts screen, all derived from rows. Months are keys; values
 * are cents. Nothing here knows about pixels.
 */
import { accountBalances, lineEffect, needsCategory } from './ledger';
import { addMonths, monthOf, monthsBetween } from './month';
import { projectLoan } from './loans';
import { RTA, type Account, type Cents, type MonthKey, type Transaction } from './types';

export interface MonthPoint { month: MonthKey; value: Cents }

/** End-of-month balances: budget accounts, tracking accounts, and both together. */
export function netWorthSeries(accounts: Account[], transactions: Transaction[], months: MonthKey[]): { budget: MonthPoint[]; tracking: MonthPoint[]; total: MonthPoint[] } {
  const onBudget = new Set(accounts.filter((a) => a.onBudget).map((a) => a.id));
  const budget: MonthPoint[] = [], tracking: MonthPoint[] = [], total: MonthPoint[] = [];
  const live = transactions.filter((t) => !t.deleted);
  for (const month of months) {
    const upTo = live.filter((t) => monthOf(t.date) <= month);
    let b = 0, tr = 0;
    for (const [id, bal] of accountBalances(accounts, upTo)) (onBudget.has(id) ? (b += bal.working) : (tr += bal.working));
    budget.push({ month, value: b });
    tracking.push({ month, value: tr });
    total.push({ month, value: b + tr });
  }
  return { budget, tracking, total };
}

/** Income into Ready to Assign and spending out of categories, per month, both as positive magnitudes. */
export function incomeSpendSeries(accounts: Account[], transactions: Transaction[], months: MonthKey[]): { income: MonthPoint[]; spending: MonthPoint[] } {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const income = new Map<MonthKey, Cents>(), spending = new Map<MonthKey, Cents>();
  for (const t of transactions) {
    if (t.deleted) continue;
    const own = byId.get(t.accountId);
    if (!own) continue;
    const m = monthOf(t.date);
    for (const l of t.lines) {
      const far = l.transferAccountId ? byId.get(l.transferAccountId) : undefined;
      if (!needsCategory(l, own, far) || !l.categoryId) continue;
      const e = lineEffect(l, own, far);
      if (l.categoryId === RTA) income.set(m, (income.get(m) ?? 0) + e);
      else spending.set(m, (spending.get(m) ?? 0) - e);
    }
  }
  return {
    income: months.map((month) => ({ month, value: income.get(month) ?? 0 })),
    spending: months.map((month) => ({ month, value: spending.get(month) ?? 0 })),
  };
}

/** One category's spending per month as a positive magnitude (refunds net against it). */
export function categorySpendSeries(activityByMonth: Map<MonthKey, Cents> | undefined, months: MonthKey[]): MonthPoint[] {
  return months.map((month) => ({ month, value: 0 - (activityByMonth?.get(month) ?? 0) }));
}

/** Balance adjustments in investment accounts (rows that are not transfers), per month and running. */
export function investmentIncomeSeries(accounts: Account[], transactions: Transaction[], months: MonthKey[]): { monthly: MonthPoint[]; cumulative: MonthPoint[] } {
  const inv = new Set(accounts.filter((a) => a.kind === 'investment').map((a) => a.id));
  const byMonth = new Map<MonthKey, Cents>();
  for (const t of transactions) {
    if (t.deleted || !inv.has(t.accountId) || t.lines.some((l) => l.transferAccountId)) continue;
    const m = monthOf(t.date);
    byMonth.set(m, (byMonth.get(m) ?? 0) + t.amount);
  }
  // Everything before the first shown month seeds the running total.
  let running = [...byMonth].filter(([m]) => months.length && m < months[0]!).reduce((s, [, v]) => s + v, 0);
  const monthly: MonthPoint[] = [], cumulative: MonthPoint[] = [];
  for (const month of months) {
    const v = byMonth.get(month) ?? 0;
    running += v;
    monthly.push({ month, value: v });
    cumulative.push({ month, value: running });
  }
  return { monthly, cumulative };
}

/** A loan's balance owed at each month end, then the projection (and a what-if) continuing from now. */
export function loanSeries(account: Account, transactions: Transaction[], currentMonth: MonthKey, lumpSum = 0): { history: MonthPoint[]; projected: MonthPoint[]; whatIf: MonthPoint[] } {
  const own = transactions.filter((t) => !t.deleted && (t.accountId === account.id || t.lines.some((l) => l.transferAccountId === account.id)));
  if (!own.length) return { history: [], projected: [], whatIf: [] };
  const first = own.reduce((m, t) => (monthOf(t.date) < m ? monthOf(t.date) : m), monthOf(own[0]!.date));
  const history = monthsBetween(first, currentMonth).map((month) => {
    const upTo = own.filter((t) => monthOf(t.date) <= month);
    return { month, value: -(accountBalances([account], upTo).get(account.id)?.working ?? 0) };
  });
  const owed = history[history.length - 1]?.value ?? 0;
  const proj = (lump: number) => account.loan && owed > 0
    ? projectLoan(owed, account.loan, addMonths(currentMonth, 1), { lumpSum: lump, maxMonths: 360 }).steps.map((s) => ({ month: s.month, value: s.owed }))
    : [];
  return { history, projected: proj(0), whatIf: lumpSum > 0 ? proj(lumpSum) : [] };
}

/** The last `count` months ending at `end`, oldest first. */
export function lastMonths(end: MonthKey, count: number): MonthKey[] {
  return monthsBetween(addMonths(end, -(count - 1)), end);
}

/** Round tick values so axes read 0 / 500 / 1,000 rather than 0 / 487 / 974. */
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.999; v += step) ticks.push(Math.round(v));
  return ticks;
}
