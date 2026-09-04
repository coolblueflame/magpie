import type { Account, Cents, ClearedState, IsoDate, Line, Transaction, TxStatus } from './types';

/**
 * Whether a line touches the budget and therefore needs a category (spec §4.3).
 * Own on-budget + no transfer: yes. Transfer: only when exactly one side is
 * on-budget (money entering or leaving the budget). Both on-budget or both
 * off-budget: no category allowed.
 */
export function needsCategory(line: Line, own: Account, far: Account | undefined): boolean {
  if (!line.transferAccountId) return own.onBudget;
  const farOn = far?.onBudget ?? false;
  return own.onBudget !== farOn;
}

/**
 * The line's amount as the budget sees it. Signed from the on-budget side:
 * a transfer entered in an off-budget account that lands in an on-budget one
 * is income to the budget, so the sign flips.
 */
export function lineEffect(line: Line, own: Account, far: Account | undefined): Cents {
  if (!needsCategory(line, own, far)) return 0;
  return own.onBudget ? line.amount : -line.amount;
}

/**
 * Problems with a transaction, in plain words; empty means valid. A category on
 * a line that does not touch the budget (an off-budget account's own row, a
 * transfer between two on-budget accounts) is allowed: it is reporting-only,
 * lineEffect returns 0 for it, and imports keep the source's classification.
 */
export function validateTransaction(tx: Transaction, accountsById: Map<string, Account>): string[] {
  const errors: string[] = [];
  const own = accountsById.get(tx.accountId);
  if (!own) return [`unknown account ${tx.accountId}`];
  const sum = tx.lines.reduce((s, l) => s + l.amount, 0);
  if (sum !== tx.amount) errors.push(`lines sum to ${sum}, amount is ${tx.amount}`);
  tx.lines.forEach((line, i) => {
    const n = i + 1;
    let far: Account | undefined;
    if (line.transferAccountId) {
      if (line.transferAccountId === tx.accountId) { errors.push(`line ${n} transfers to its own account`); return; }
      far = accountsById.get(line.transferAccountId);
      if (!far) { errors.push(`line ${n} transfers to unknown account ${line.transferAccountId}`); return; }
    }
    if (needsCategory(line, own, far) && !line.categoryId && tx.status === 'ok') errors.push(`line ${n} needs a category`);
  });
  return errors;
}

/**
 * Working and cleared balance per account. A transfer is one row: its own
 * account takes `amount`, the far account takes the line amount negated, and
 * the far side's cleared state is the line's `farCleared` (spec §4.3).
 */
export function accountBalances(
  accounts: Account[],
  transactions: Transaction[],
): Map<string, { working: Cents; cleared: Cents }> {
  const out = new Map(accounts.map((a) => [a.id, { working: 0, cleared: 0 }]));
  for (const tx of transactions) {
    if (tx.deleted) continue;
    const own = out.get(tx.accountId);
    if (own) {
      own.working += tx.amount;
      if (tx.cleared === 'cleared') own.cleared += tx.amount;
    }
    for (const line of tx.lines) {
      if (!line.transferAccountId) continue;
      const far = out.get(line.transferAccountId);
      if (!far) continue;
      far.working -= line.amount;
      if (line.farCleared === 'cleared') far.cleared -= line.amount;
    }
  }
  return out;
}

export type LedgerKind =
  | { type: 'category'; categoryId?: string }
  | { type: 'transfer'; accountId: string; categoryId?: string }
  | { type: 'split'; lines: number };

/** One line of an account's ledger: an own transaction, or the far side of a transfer owned elsewhere. */
export interface LedgerRow {
  /** txId for own rows; `${txId}:${lineIndex}` for far rows. */
  id: string;
  txId: string;
  far: boolean;
  ownerAccountId: string;
  date: IsoDate;
  payeeId?: string;
  memo: string;
  /** This account's view; far rows negate the transfer line. */
  amount: Cents;
  cleared: ClearedState;
  status: TxStatus;
  kind: LedgerKind;
  /** Balance after this row, in date order. */
  running: Cents;
}

function kindOf(lines: Line[]): LedgerKind {
  if (lines.length !== 1) return { type: 'split', lines: lines.length };
  const l = lines[0]!;
  if (l.transferAccountId) return { type: 'transfer', accountId: l.transferAccountId, ...(l.categoryId ? { categoryId: l.categoryId } : {}) };
  return l.categoryId ? { type: 'category', categoryId: l.categoryId } : { type: 'category' };
}

/**
 * An account's ledger, newest first, with running balances. A transfer is one
 * stored row, so the far account sees it here as a derived row it does not own.
 */
export function ledgerRows(accountId: string, transactions: Transaction[]): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const tx of transactions) {
    if (tx.deleted) continue;
    if (tx.accountId === accountId) {
      rows.push({
        id: tx.id, txId: tx.id, far: false, ownerAccountId: tx.accountId, date: tx.date, memo: tx.memo,
        amount: tx.amount, cleared: tx.cleared, status: tx.status, kind: kindOf(tx.lines), running: 0,
        ...(tx.payeeId ? { payeeId: tx.payeeId } : {}),
      });
      continue;
    }
    tx.lines.forEach((l, i) => {
      if (l.transferAccountId !== accountId) return;
      rows.push({
        id: `${tx.id}:${i}`, txId: tx.id, far: true, ownerAccountId: tx.accountId, date: tx.date, memo: l.memo || tx.memo,
        amount: -l.amount, cleared: l.farCleared ?? 'uncleared', status: tx.status,
        kind: { type: 'transfer', accountId: tx.accountId, ...(l.categoryId ? { categoryId: l.categoryId } : {}) }, running: 0,
        ...(tx.payeeId ? { payeeId: tx.payeeId } : {}),
      });
    });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let running = 0;
  for (const r of rows) { running += r.amount; r.running = running; }
  return rows.reverse();
}
