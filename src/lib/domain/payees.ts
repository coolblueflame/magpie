import type { Account, IsoDate, Transaction } from './types';

/** The alias key for a raw descriptor or a payee name: trimmed, single-spaced, case-folded. */
export function normalisePayeeKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The category to pre-fill for a payee: its newest confirmed transaction in an
 * on-budget account with a single categorised, non-transfer line (spec §4.5).
 */
export function payeeLastCategory(payeeId: string, transactions: Transaction[], accountsById: Map<string, Account>): string | undefined {
  let best: Transaction | undefined;
  for (const tx of transactions) {
    if (tx.deleted || tx.payeeId !== payeeId || tx.status !== 'ok' || tx.lines.length !== 1) continue;
    const line = tx.lines[0]!;
    if (!line.categoryId || line.transferAccountId || !accountsById.get(tx.accountId)?.onBudget) continue;
    if (!best || tx.date > best.date || (tx.date === best.date && tx.updatedAt > best.updatedAt)) best = tx;
  }
  return best?.lines[0]!.categoryId;
}

/** How often and how recently each payee appears. */
export function payeeUsage(transactions: Transaction[]): Map<string, { count: number; last: IsoDate }> {
  const out = new Map<string, { count: number; last: IsoDate }>();
  for (const tx of transactions) {
    if (tx.deleted || !tx.payeeId) continue;
    const u = out.get(tx.payeeId) ?? { count: 0, last: tx.date };
    u.count++;
    if (tx.date > u.last) u.last = tx.date;
    out.set(tx.payeeId, u);
  }
  return out;
}
