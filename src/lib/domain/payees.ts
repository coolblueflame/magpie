import { similarity } from './matcher';
import type { Account, IsoDate, Payee, Transaction } from './types';

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

/** The pre-fill category for every payee at once, by the same rule as payeeLastCategory; one pass over the table. */
export function payeeLastCategories(transactions: Transaction[], accountsById: Map<string, Account>): Map<string, string> {
  const best = new Map<string, Transaction>();
  for (const tx of transactions) {
    if (tx.deleted || !tx.payeeId || tx.status !== 'ok' || tx.lines.length !== 1) continue;
    const line = tx.lines[0]!;
    if (!line.categoryId || line.transferAccountId || !accountsById.get(tx.accountId)?.onBudget) continue;
    const b = best.get(tx.payeeId);
    if (!b || tx.date > b.date || (tx.date === b.date && tx.updatedAt > b.updatedAt)) best.set(tx.payeeId, tx);
  }
  return new Map([...best].map(([id, tx]) => [id, tx.lines[0]!.categoryId!]));
}

/**
 * The existing payee a new statement descriptor most likely is. Bank importers
 * and statements name the same merchant differently, so a fresh raw payee with
 * no history usually has a twin among the payees that do. Only payees with a
 * history count as candidates, and the descriptor's own payee never does.
 */
export function suggestPayee(descriptor: string, payees: Payee[], hasHistory: (payeeId: string) => boolean, excludeId?: string, floor = 0.6): { payee: Payee; similarity: number } | null {
  let best: { payee: Payee; similarity: number } | null = null;
  for (const p of payees) {
    if (p.deleted || p.id === excludeId || !hasHistory(p.id)) continue;
    const s = similarity(descriptor, p.name);
    if (s >= floor && (!best || s > best.similarity)) best = { payee: p, similarity: s };
  }
  return best;
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
