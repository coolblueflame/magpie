import { describe, expect, test } from 'vitest';
import { draftFromTransaction, emptyDraft, fieldsFromDraft } from './transactions';
import { seedData } from './seed';

describe('transaction drafts', () => {
  const s = seedData('2026-09');
  const accountsById = new Map(s.accounts.map((a) => [a.id, a]));
  const byId = (id: string) => s.transactions.find((t) => t.id === id)!;

  test('round-trips a transfer with a category and far state', () => {
    const tx = byId('seed_t6');
    const d = draftFromTransaction(tx);
    expect(d).toMatchObject({ outflow: 50000, inflow: 0, split: false, target: { type: 'transfer', accountId: 'acc_inv', categoryId: 'cat_save', farCleared: 'cleared' } });
    const f = fieldsFromDraft(d, accountsById);
    expect(f.amount).toBe(-50000);
    expect(f.lines).toEqual(tx.lines);
    expect(f.status).toBe('ok');
  });
  test('a split draft builds lines and needs every line to sum', () => {
    const d = { ...emptyDraft('acc_card', '2026-09-06'), outflow: 1200, split: true, lines: [
      { target: { type: 'category' as const, categoryId: 'cat_groc' }, amount: -800, memo: 'a' },
      { target: { type: 'category' as const, categoryId: 'cat_fun' }, amount: -400, memo: 'b' },
    ] };
    const f = fieldsFromDraft(d, accountsById);
    expect(f.lines).toHaveLength(2);
    expect(f.status).toBe('ok');
    expect(draftFromTransaction({ ...byId('seed_t1'), ...f }).lines).toHaveLength(2);
    expect(() => fieldsFromDraft({ ...d, outflow: 1300 }, accountsById)).toThrow(/sum/);
  });
  test('a missing category leaves the row new; an impossible transfer throws', () => {
    const d = { ...emptyDraft('acc_card', '2026-09-06'), outflow: 500 };
    expect(fieldsFromDraft(d, accountsById).status).toBe('new');
    expect(fieldsFromDraft({ ...d, target: { type: 'category', categoryId: 'cat_fun' } }, accountsById).status).toBe('ok');
    expect(fieldsFromDraft({ ...d, accountId: 'acc_inv' }, accountsById).status).toBe('ok');   // off-budget needs none
    expect(() => fieldsFromDraft({ ...d, target: { type: 'transfer', accountId: 'acc_card' } }, accountsById)).toThrow(/own account/);
  });
});
