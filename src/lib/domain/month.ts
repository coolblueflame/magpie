import type { IsoDate, MonthKey } from './types';

export function monthOf(date: IsoDate): MonthKey {
  return date.slice(0, 7);
}

export function addMonths(month: MonthKey, n: number): MonthKey {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + n;
  const year = y + Math.floor(m / 12);
  const mon = ((m % 12) + 12) % 12;
  return `${year}-${String(mon + 1).padStart(2, '0')}`;
}

export function compareMonths(a: MonthKey, b: MonthKey): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function maxMonth(first: MonthKey, ...rest: MonthKey[]): MonthKey {
  return rest.reduce((m, x) => (x > m ? x : m), first);
}

export function minMonth(first: MonthKey, ...rest: MonthKey[]): MonthKey {
  return rest.reduce((m, x) => (x < m ? x : m), first);
}

/** Inclusive; empty when from is after to. */
export function monthsBetween(from: MonthKey, to: MonthKey): MonthKey[] {
  const out: MonthKey[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

const NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function monthLabel(month: MonthKey): string {
  return `${NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

/** Today's ISO date in local time; toISOString would give the UTC day, which is tomorrow every evening in the Americas. */
export function todayKey(d: Date = new Date()): IsoDate {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The month of a local-time Date; the budget follows the wall clock, not UTC. */
export function monthKeyOf(d: Date): MonthKey {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
