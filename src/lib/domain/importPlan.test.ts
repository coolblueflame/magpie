import { describe, expect, test } from 'vitest';
import { planImport, type ImportCandidate, type ImportState } from './importPlan';
import { seedData } from './seed';
import type { Transaction } from './types';

const cand = (externalId: string, date: string, amount: number, descriptor: string, memo = ''): ImportCandidate =>
  ({ externalId, date, amount, descriptor, memo, source: { kind: 'ofx', batchId: 'b1' } });

function stateFrom(over: Partial<ImportState> = {}): ImportState {
  const s = seedData('2026-09');
  return { transactions: s.transactions, payees: s.payees, accountsById: new Map(s.accounts.map((a) => [a.id, a])), ...over };
}

describe('planImport', () => {
  test('known ids skip, manual rows link and clear, far transfer sides get the id on their line, the rest are new', () => {
    const s = stateFrom();
    const known: Transaction = { ...s.transactions[0]!, id: 'k', accountId: 'acc_card', externalId: 'fit-known', amount: -100, lines: [{ categoryId: 'cat_fun', amount: -100, memo: '' }] };
    const manual: Transaction = { ...s.transactions[0]!, id: 'm', accountId: 'acc_card', date: '2026-09-03', amount: -999, cleared: 'uncleared', payeeId: 'pay_arcade', lines: [{ categoryId: 'cat_fun', amount: -999, memo: '' }] };
    delete (manual as Partial<Transaction>).externalId;
    s.transactions = [...s.transactions, known, manual];
    let n = 0;
    const plan = planImport([
      cand('fit-known', '2026-09-01', -100, 'ANYTHING'),
      cand('fit-manual', '2026-09-05', -999, 'ARCADE FUN CENTRE'),
      cand('fit-payment', '2026-08-14', 38000, 'PAYMENT THANK YOU'),
      cand('fit-new', '2026-09-06', -1234, 'GROCER MART #12'),
      cand('fit-new2', '2026-09-06', -500, 'grocer mart #12'),
    ], 'acc_card', s, () => `id${++n}`);

    expect(plan.summary).toBe('5 in file: 1 already imported, 2 matched, 2 new');
    expect(plan.matched.map((m) => [m.txId, m.side])).toEqual([['m', 'own'], ['seed_t10', 'far']]);
    const own = plan.edits.find((e) => 'patch' in e && e.id === 'm')!;
    expect(own).toMatchObject({ patch: { externalId: 'fit-manual', cleared: 'cleared' } });
    const far = plan.edits.find((e) => 'patch' in e && e.id === 'seed_t10') as unknown as { patch: { lines: { farExternalId?: string; farCleared?: string }[] } };
    expect(far.patch.lines[0]).toMatchObject({ farExternalId: 'fit-payment', farCleared: 'cleared' });
    // One new payee for both new rows (same descriptor, different case), created once.
    expect(plan.payeesToCreate).toEqual([{ id: 'id1', name: 'GROCER MART #12' }]);
    const creates = plan.edits.filter((e) => 'create' in e && e.table === 'transactions') as { create: Record<string, unknown> }[];
    expect(creates).toHaveLength(2);
    expect(creates[0]!.create).toMatchObject({ accountId: 'acc_card', status: 'new', externalId: 'fit-new', payeeId: 'id1', cleared: 'cleared', lines: [{ amount: -1234, memo: '' }] });
    expect(creates[1]!.create).toMatchObject({ payeeId: 'id1' });
  });

  test('an existing payee is reused by alias; tracking accounts create rows already ok', () => {
    const s = stateFrom();
    s.payees = s.payees.map((p) => (p.id === 'pay_grocer' ? { ...p, aliases: ['grocer mart #12 townsville'] } : p));
    const plan = planImport([cand('x1', '2026-09-06', -1234, 'GROCER MART #12  TOWNSVILLE')], 'acc_card', s);
    expect(plan.payeesToCreate).toEqual([]);
    expect((plan.edits[0] as unknown as { create: { payeeId: string } }).create.payeeId).toBe('pay_grocer');
    const inv = planImport([cand('y1', '2026-09-06', 900, 'DIVIDEND')], 'acc_inv', s);
    expect((inv.edits.find((e) => e.table === 'transactions') as unknown as { create: { status: string } }).create.status).toBe('ok');
  });

  test('a matched candidate never creates; unknown account throws', () => {
    const s = stateFrom();
    const plan = planImport([cand('p', '2026-08-14', 38000, 'PAYMENT')], 'acc_card', s);
    expect(plan.created).toEqual([]);
    expect(() => planImport([], 'nope', s)).toThrow(/unknown account/);
  });
});
