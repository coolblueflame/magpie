/** Free-text transaction search across every account. */
import { kindLabel, kindOf } from './ledger';
import { RTA, type Account, type Category, type Payee, type Transaction } from './types';

export interface SearchNames { accounts: Account[]; categories: Category[]; payees: Payee[] }
export interface SearchResult { hits: Transaction[]; total: number }

/** Lower-case, with the punctuation people type into amounts ($ and thousands commas) removed. */
const clean = (s: string) => s.toLowerCase().replace(/[$,]/g, '');
const dollars = (cents: number) => (Math.abs(cents) / 100).toFixed(2);

/**
 * Transactions whose text matches every word of `query`, newest first.
 * The searchable text is the date, account, payee, memo, the ledger's target
 * label, each line's memo, category and amount, and "new" for unreviewed rows,
 * so a query reads the way the ledger does. Amounts match on their absolute
 * dollar value ("12.34" finds both a charge and a refund).
 */
export function searchTransactions(query: string, transactions: Transaction[], names: SearchNames, limit = 200): SearchResult {
  const terms = clean(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return { hits: [], total: 0 };
  const acct = new Map(names.accounts.map((a) => [a.id, a.name]));
  const cat = new Map(names.categories.map((c) => [c.id, c.name]));
  const pay = new Map(names.payees.map((p) => [p.id, p.name]));
  const accountName = (id: string) => acct.get(id) ?? '';
  const categoryName = (id: string) => (id === RTA ? 'Ready to Assign' : cat.get(id) ?? '');
  const hits: Transaction[] = [];
  for (const t of transactions) {
    if (t.deleted) continue;
    const parts = [t.date, accountName(t.accountId), t.payeeId ? pay.get(t.payeeId) ?? '' : '', t.memo, dollars(t.amount), kindLabel(kindOf(t.lines), accountName, categoryName)];
    for (const l of t.lines) {
      parts.push(l.memo, dollars(l.amount));
      if (l.categoryId) parts.push(categoryName(l.categoryId));
    }
    if (t.status === 'new') parts.push('new');
    const hay = clean(parts.join(' '));
    if (terms.every((w) => hay.includes(w))) hits.push(t);
  }
  hits.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? -1 : 1));
  return { hits: hits.slice(0, limit), total: hits.length };
}
