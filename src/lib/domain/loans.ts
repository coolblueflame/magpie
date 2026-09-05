/**
 * Loan arithmetic (spec §4.8). Balances "owed" are positive here even though
 * a loan account's ledger balance is negative; callers negate at the edge.
 */
import { roundHalfAway } from './money';
import { addMonths, monthOf } from './month';
import type { Account, Cents, IsoDate, LoanTerms, MonthKey, Transaction } from './types';

/** One month of interest on what is owed, half away from zero; nothing on a paid-off loan. */
export function monthlyInterest(owed: Cents, annualRatePct: number): Cents {
  if (owed <= 0) return 0;
  return roundHalfAway((owed * annualRatePct) / 1200);
}

export interface ProjectionStep {
  month: MonthKey;
  interest: Cents;
  payment: Cents;
  owed: Cents;
}

export interface Projection {
  steps: ProjectionStep[];
  /** The month the balance reaches zero, or null when it never does within the horizon. */
  payoffMonth: MonthKey | null;
  months: number;
  totalInterest: Cents;
  /** The standard payment does not exceed the first month's interest, so the balance never falls. */
  stalls: boolean;
}

/**
 * Month by month from `fromMonth`: interest first, then the standard payment
 * capped at what is owed. A lump sum is applied before the first month.
 */
export function projectLoan(owed: Cents, terms: LoanTerms, fromMonth: MonthKey, opts: { lumpSum?: Cents; maxMonths?: number } = {}): Projection {
  const maxMonths = opts.maxMonths ?? 600;
  let balance = Math.max(0, owed - (opts.lumpSum ?? 0));
  const steps: ProjectionStep[] = [];
  let totalInterest = 0;
  const stalls = balance > 0 && terms.standardPayment <= monthlyInterest(balance, terms.annualRatePct);
  let month = fromMonth;
  while (balance > 0 && steps.length < maxMonths && !stalls) {
    const interest = monthlyInterest(balance, terms.annualRatePct);
    balance += interest;
    const payment = Math.min(terms.standardPayment, balance);
    balance -= payment;
    totalInterest += interest;
    steps.push({ month, interest, payment, owed: balance });
    month = addMonths(month, 1);
  }
  const paid = balance === 0;
  return { steps, payoffMonth: paid && steps.length ? steps[steps.length - 1]!.month : paid ? fromMonth : null, months: steps.length, totalInterest, stalls };
}

/** The standard projection against one with a lump sum paid now. */
export function whatIf(owed: Cents, terms: LoanTerms, fromMonth: MonthKey, lumpSum: Cents) {
  const base = projectLoan(owed, terms, fromMonth);
  const withLump = projectLoan(owed, terms, fromMonth, { lumpSum });
  return { base, withLump, monthsSaved: base.months - withLump.months, interestSaved: base.totalInterest - withLump.totalInterest };
}

export const interestRowId = (accountId: string, month: MonthKey) => `int_${accountId}_${month}`;

/**
 * Interest rows a loan still needs up to today: one per month from the loan's
 * first transaction month, dated `interestDay`, each on the balance owed at the
 * end of that day including the rows this call adds earlier. Idempotent by id.
 */
export function dueInterest(account: Account, transactions: Transaction[], today: IsoDate): { month: MonthKey; date: IsoDate; amount: Cents; id: string }[] {
  const terms = account.loan;
  if (!terms?.generateInterest || terms.annualRatePct <= 0) return [];
  const own = transactions.filter((t) => !t.deleted && t.accountId === account.id).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!own.length) return [];
  const existing = new Set(own.map((t) => t.id));
  const day = String(Math.min(28, Math.max(1, terms.interestDay))).padStart(2, '0');
  const out: { month: MonthKey; date: IsoDate; amount: Cents; id: string }[] = [];
  const posted: { date: IsoDate; amount: Cents }[] = [];
  for (let month = monthOf(own[0]!.date); month <= monthOf(today); month = addMonths(month, 1)) {
    const date = `${month}-${day}`;
    if (date > today) break;
    const id = interestRowId(account.id, month);
    if (existing.has(id)) continue;
    // Interest posts at the end of its day: every row dated on or before it counts,
    // including interest rows generated earlier in this pass.
    const balance = own.filter((t) => t.date <= date).reduce((s, t) => s + t.amount, 0)
      + transactions.filter((t) => !t.deleted && t.accountId !== account.id).flatMap((t) => t.lines.filter((l) => l.transferAccountId === account.id && t.date <= date).map((l) => -l.amount)).reduce((s, v) => s + v, 0)
      + posted.filter((p) => p.date < date).reduce((s, p) => s + p.amount, 0);
    const interest = monthlyInterest(-balance, terms.annualRatePct);
    if (interest === 0) continue;
    const amount = -interest;
    out.push({ month, date, amount, id });
    posted.push({ date, amount });
  }
  return out;
}
