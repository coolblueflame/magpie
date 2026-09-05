/**
 * Shared expenses with a person account (spec §4.4). One rule covers every
 * case: for a row with total T (what both paid together), the user's own
 * payment X and the partner's share p%, the partner's share is
 * S = roundHalfAway(T × p / 100) and the user's is T − S; the user's bank row
 * (−X) splits into a category line for −(T − S) and a transfer to the person
 * account for the difference.
 */
import { roundHalfAway } from './money';
import type { Cents, Line } from './types';

export function shareSplit(total: Cents, percent: number): { mine: Cents; theirs: Cents } {
  const theirs = roundHalfAway((total * percent) / 100);
  return { mine: total - theirs, theirs };
}

/**
 * Lines for a bank row of `amount` (negative for spending) that covers `total`
 * shared at `percent`. A zero transfer line is dropped; the lines always sum to
 * `amount`.
 */
export function sharedLines(amount: Cents, total: Cents, percent: number, categoryId: string | undefined, personAccountId: string): Line[] {
  const { mine } = shareSplit(total, percent);
  const lines: Line[] = [{ amount: -mine, memo: '', ...(categoryId ? { categoryId } : {}) }];
  const transfer = amount + mine;   // −(X − mine) with X = −amount
  if (transfer !== 0) lines.push({ transferAccountId: personAccountId, amount: transfer, memo: '' });
  if (mine === 0) lines.shift();
  if (!lines.length) lines.push({ amount, memo: '', ...(categoryId ? { categoryId } : {}) });
  return lines;
}
