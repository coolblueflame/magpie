import { describe, expect, it } from 'vitest';
import { searchTransactions } from './search';
import type { Account, Category, Line, Payee, Transaction } from './types';

const base = { updatedAt: 1, deleted: false };
const acc = (id: string, name: string): Account => ({ ...base, id, name, kind: 'chequing', onBudget: true, closed: false, sortOrder: 0, note: '' });
const accounts = [acc('a1', 'Chequing'), acc('a2', 'Visa')];
const categories: Category[] = [{ ...base, id: 'c1', groupId: 'g', name: 'Groceries', goal: 0, hidden: false, sortOrder: 0, note: '' }];
const payees: Payee[] = [{ ...base, id: 'p1', name: 'Corner Market', aliases: [], note: '' }];
const tx = (id: string, accountId: string, date: string, amount: number, lines: Line[], over: Partial<Transaction> = {}): Transaction => ({
  ...base, id, accountId, date, memo: '', amount, cleared: 'cleared', status: 'ok', source: { kind: 'manual', batchId: 'b' }, lines, ...over,
});
const txs: Transaction[] = [
  tx('t1', 'a2', '2026-08-03', -1234, [{ categoryId: 'c1', amount: -1234, memo: '' }], { payeeId: 'p1' }),
  tx('t2', 'a1', '2026-08-10', -38000, [{ transferAccountId: 'a2', amount: -38000, memo: '' }]),
  tx('t3', 'a2', '2026-09-01', -1234, [{ categoryId: 'c1', amount: -600, memo: 'apples' }, { amount: -634, memo: 'stamps' }], { memo: 'two things', status: 'new' }),
  tx('t4', 'a1', '2026-09-02', 1234, [{ categoryId: 'c1', amount: 1234, memo: '' }], { payeeId: 'p1', deleted: true }),
];
const names = { accounts, categories, payees };
const ids = (q: string) => searchTransactions(q, txs, names).hits.map((t) => t.id);

describe('searchTransactions', () => {
  it('matches payee, category, account, transfer label, memo and line memo; newest first', () => {
    expect(ids('market')).toEqual(['t1']);
    expect(ids('groceries')).toEqual(['t3', 't1']);
    expect(ids('visa')).toEqual(['t3', 't2', 't1']);
    expect(ids('transfer')).toEqual(['t2']);
    expect(ids('things')).toEqual(['t3']);
    expect(ids('stamps')).toEqual(['t3']);
  });
  it('matches amounts by absolute dollars, with $ and commas ignored, on the row or a line', () => {
    expect(ids('12.34')).toEqual(['t3', 't1']);
    expect(ids('$380')).toEqual(['t2']);
    expect(ids('6.00')).toEqual(['t3']);
  });
  it('requires every word, matches dates by prefix, and flags new rows', () => {
    expect(ids('market 2026-08')).toEqual(['t1']);
    expect(ids('market 2026-09')).toEqual([]);
    expect(ids('new')).toEqual(['t3']);
  });
  it('ignores empty queries and tombstones, and caps hits while reporting the total', () => {
    expect(searchTransactions('  ', txs, names)).toEqual({ hits: [], total: 0 });
    expect(ids('12.34')).not.toContain('t4');
    const r = searchTransactions('a', txs, names, 1);
    expect(r.hits).toHaveLength(1);
    expect(r.total).toBe(3);
  });
});
