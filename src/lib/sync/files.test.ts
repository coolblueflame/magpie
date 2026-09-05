import { describe, expect, test } from 'vitest';
import { fromFiles, SchemaTooNewError, SCHEMA_VERSION, toFiles } from './files';
import { canonical } from './merge';
import type { Snapshot } from '../storage/repo';

const NOW = new Date('2026-09-05T12:00:00Z');
const fresh = NOW.getTime() - 1000;
const stamp = { updatedAt: fresh, editedAt: fresh, deleted: false };

/** One row per table with every optional field populated, so a field the layout forgot shows up as a diff. */
export function fullSnapshot(): Snapshot {
  return {
    accounts: [{ ...stamp, id: 'a1', name: 'Chequing', kind: 'chequing', onBudget: true, closed: false, sortOrder: 0, note: 'n', externalRef: 'deadbeef' }],
    groups: [{ ...stamp, id: 'g1', name: 'Everyday', sortOrder: 0, hidden: false }],
    categories: [{ ...stamp, id: 'c1', groupId: 'g1', name: 'Groceries', goal: 60000, sortOrder: 0, hidden: false, note: 'x', carriedIn: 1234 }],
    assignments: [{ ...stamp, id: 'asg_c1_2026-09', categoryId: 'c1', month: '2026-09', amount: 60000 }],
    transactions: [
      { ...stamp, id: 't1', accountId: 'a1', date: '2026-09-03', payeeId: 'p1', memo: 'm', amount: -1000, cleared: 'cleared', status: 'ok', externalId: 'fitid:1', source: { kind: 'ofx', profileId: 'pr1', batchId: 'b' }, shared: { accountId: 'a1', percent: 35 },
        lines: [{ categoryId: 'c1', amount: -650, memo: 'l' }, { transferAccountId: 'a1', amount: -350, memo: '', farCleared: 'uncleared', farExternalId: 'fitid:9' }] },
      { ...stamp, id: 't2', accountId: 'a1', date: '2025-12-31', memo: '', amount: 500, cleared: 'uncleared', status: 'new', source: { kind: 'manual', batchId: 'b' }, lines: [{ amount: 500, memo: '' }] },
    ],
    payees: [{ ...stamp, id: 'p1', name: 'Grocer', aliases: ['grocer mart'], note: '' }],
    claims: [{ ...stamp, id: 'k1', date: '2026-09-01', total: 10000, paid: 10000, percent: 35, description: 'Grocer', categoryHint: 'Groceries', status: 'applied', transactionId: 't1' }],
    profiles: [{ ...stamp, id: 'pr1', headerSignature: 'date|desc|amount', name: 'Bank', mapping: { date: 'Date', payee: 'Desc', memo: 'Memo', id: 'Ref', amount: 'Amount' }, dateFormat: 'YYYY-MM-DD', amountMode: 'signed', accountId: 'a1' }],
    history: [{ ...stamp, id: 'yh_c1_2026-08', categoryId: 'c1', month: '2026-08', assigned: 1, activity: -2, available: 3 }],
    settings: { cutoverMonth: '2026-09', sheet: { mineFirst: true, personAccountId: 'a1' } },
    settingsUpdatedAt: fresh,
  };
}

describe('files', () => {
  test('round trip with every field populated', () => {
    const snap = fullSnapshot();
    const files = toFiles(snap, NOW);
    expect(Object.keys(files).sort()).toEqual(['active.json', 'assignments.json', 'history.json', 'meta.json', 'tx-2025.json', 'tx-2026.json']);
    expect(canonical(fromFiles(files))).toBe(canonical(snap));
  });
  test('tombstones compact after 90 days, recent ones travel', () => {
    const snap = fullSnapshot();
    const old = NOW.getTime() - 91 * 86_400_000;
    snap.payees.push({ ...stamp, id: 'p-old', name: 'Gone', aliases: [], note: '', deleted: true, updatedAt: old, editedAt: old });
    snap.payees.push({ ...stamp, id: 'p-new', name: 'Going', aliases: [], note: '', deleted: true });
    const back = fromFiles(toFiles(snap, NOW));
    expect(back.payees.map((p) => p.id).sort()).toEqual(['p-new', 'p1']);
  });
  test('a newer schema anywhere throws before anything is read', () => {
    const files = toFiles(fullSnapshot(), NOW);
    expect(() => fromFiles({ ...files, 'meta.json': { schema: SCHEMA_VERSION + 1 } })).toThrow(SchemaTooNewError);
    expect(() => fromFiles({ ...files, 'tx-2026.json': { schema: SCHEMA_VERSION + 1, transactions: [] } })).toThrow(SchemaTooNewError);
  });
  test('missing files read as empty; a row in two year files keeps the newest', () => {
    expect(fromFiles({})).toMatchObject({ accounts: [], transactions: [], settings: {}, settingsUpdatedAt: 0 });
    const snap = fullSnapshot();
    const files = toFiles(snap, NOW);
    const t1 = snap.transactions[0]!;
    files['tx-2024.json'] = { schema: SCHEMA_VERSION, transactions: [{ ...t1, memo: 'newer', updatedAt: t1.updatedAt + 5 }] };
    expect(fromFiles(files).transactions.find((t) => t.id === 't1')!.memo).toBe('newer');
  });
});
