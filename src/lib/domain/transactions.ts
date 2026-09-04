import { needsCategory, validateTransaction } from './ledger';
import type { Account, Cents, ClearedState, IsoDate, Line, Transaction } from './types';

export type LineTarget =
  | { type: 'none' }
  | { type: 'category'; categoryId: string }
  | { type: 'transfer'; accountId: string; categoryId?: string; farCleared?: ClearedState; farExternalId?: string };

export interface LineDraft { target: LineTarget; amount: Cents; memo: string }

/** What the transaction editor holds. Outflow and inflow are both positive; amount = inflow − outflow. */
export interface TxDraft {
  accountId: string;
  date: IsoDate;
  payeeId?: string;
  memo: string;
  outflow: Cents;
  inflow: Cents;
  cleared: ClearedState;
  split: boolean;
  target: LineTarget;
  lines: LineDraft[];
}

function targetOf(line: Line): LineTarget {
  if (line.transferAccountId) {
    return {
      type: 'transfer', accountId: line.transferAccountId,
      ...(line.categoryId ? { categoryId: line.categoryId } : {}),
      ...(line.farCleared ? { farCleared: line.farCleared } : {}),
      ...(line.farExternalId ? { farExternalId: line.farExternalId } : {}),
    };
  }
  return line.categoryId ? { type: 'category', categoryId: line.categoryId } : { type: 'none' };
}

function lineOf(target: LineTarget, amount: Cents, memo: string): Line {
  const base: Line = { amount, memo };
  if (target.type === 'category') return { ...base, categoryId: target.categoryId };
  if (target.type === 'transfer') {
    return {
      ...base, transferAccountId: target.accountId,
      ...(target.categoryId ? { categoryId: target.categoryId } : {}),
      ...(target.farCleared ? { farCleared: target.farCleared } : {}),
      ...(target.farExternalId ? { farExternalId: target.farExternalId } : {}),
    };
  }
  return base;
}

export function emptyDraft(accountId: string, date: IsoDate): TxDraft {
  return { accountId, date, memo: '', outflow: 0, inflow: 0, cleared: 'uncleared', split: false, target: { type: 'none' }, lines: [] };
}

export function draftFromTransaction(tx: Transaction): TxDraft {
  const split = tx.lines.length > 1;
  return {
    accountId: tx.accountId, date: tx.date, memo: tx.memo,
    outflow: tx.amount < 0 ? -tx.amount : 0, inflow: tx.amount > 0 ? tx.amount : 0,
    cleared: tx.cleared, split,
    target: split ? { type: 'none' } : targetOf(tx.lines[0] ?? { amount: 0, memo: '' }),
    lines: split ? tx.lines.map((l) => ({ target: targetOf(l), amount: l.amount, memo: l.memo })) : [],
    ...(tx.payeeId ? { payeeId: tx.payeeId } : {}),
  };
}

/**
 * The stored fields for a draft. Throws on anything the ledger rules reject
 * except a missing category, which leaves the row `new` (spec §4.6).
 */
export function fieldsFromDraft(draft: TxDraft, accountsById: Map<string, Account>):
  Pick<Transaction, 'accountId' | 'date' | 'payeeId' | 'memo' | 'amount' | 'cleared' | 'status' | 'lines'> {
  const amount = draft.inflow - draft.outflow;
  const lines = draft.split
    ? draft.lines.map((l) => lineOf(l.target, l.amount, l.memo))
    : [lineOf(draft.target, amount, '')];
  const own = accountsById.get(draft.accountId);
  if (!own) throw new Error(`unknown account ${draft.accountId}`);
  const missing = lines.some((l) => {
    const far = l.transferAccountId ? accountsById.get(l.transferAccountId) : undefined;
    return !l.categoryId && needsCategory(l, own, far);
  });
  const status = missing ? 'new' : 'ok';
  const probe: Transaction = {
    id: 'draft', accountId: draft.accountId, date: draft.date, memo: draft.memo, amount, cleared: draft.cleared,
    status, source: { kind: 'manual', batchId: 'draft' }, lines, updatedAt: 0, deleted: false,
  };
  const errors = validateTransaction(probe, accountsById);
  if (errors.length) throw new Error(errors.join('; '));
  return {
    accountId: draft.accountId, date: draft.date, memo: draft.memo, amount, cleared: draft.cleared, status, lines,
    ...(draft.payeeId ? { payeeId: draft.payeeId } : {}),
  };
}
