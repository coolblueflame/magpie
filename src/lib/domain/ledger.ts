import type { Account, Cents, Line, Transaction } from './types';

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

/** Problems with a transaction, in plain words; empty means valid. */
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
    const needs = needsCategory(line, own, far);
    if (needs && !line.categoryId && tx.status === 'ok') errors.push(`line ${n} needs a category`);
    if (!needs && line.categoryId) errors.push(`line ${n} must not have a category`);
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
