import { describe, expect, test } from 'vitest';
import { fromFiles, SchemaTooNewError, SCHEMA_VERSION, toFiles } from './files';
import { canonical } from './merge';
import { fullSnapshot, NOW, stamp } from './fixtures';

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
