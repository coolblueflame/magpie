import { beforeEach, describe, expect, test } from 'vitest';
import { openDb, type MagpieDb } from './db';
import { nextStamp, Repo } from './repo';
import type { Account, Category } from '../domain/types';

let db: MagpieDb;
let repo: Repo;
let n = 0;
beforeEach(() => {
  db = openDb(`test-${++n}-${Date.now()}`);
  repo = new Repo(db);
});

const draft = { name: 'Chequing', kind: 'chequing' as const, onBudget: true, closed: false, sortOrder: 0, note: '' };

describe('nextStamp', () => {
  test('is now, or one past a future stamp', () => {
    const now = Date.now();
    expect(nextStamp(0)).toBeGreaterThanOrEqual(now);
    expect(nextStamp(now + 100000)).toBe(now + 100001);
  });
});

describe('Repo', () => {
  test('create stamps and loadState returns it', async () => {
    const a = await repo.create<Account>('accounts', draft);
    expect(a.id).toBeTruthy();
    expect(a.deleted).toBe(false);
    expect(a.updatedAt).toBeGreaterThan(0);
    const s = await repo.loadState();
    expect(s.accounts.map((x) => x.id)).toEqual([a.id]);
  });
  test('create honours a supplied id', async () => {
    const a = await repo.create<Account>('accounts', { ...draft, id: 'acc_fixed' });
    expect(a.id).toBe('acc_fixed');
  });
  test('patch bumps updatedAt past the old one and sets editedAt', async () => {
    const a = await repo.create<Account>('accounts', draft);
    const future = Date.now() + 100000;
    await db.accounts.put({ ...a, updatedAt: future });
    const p = await repo.patch<Account>('accounts', a.id, { name: 'Main' });
    expect(p!.name).toBe('Main');
    expect(p!.updatedAt).toBe(future + 1);
    expect(p!.editedAt).toBeGreaterThan(0);
    expect((await db.accounts.get(a.id))!.name).toBe('Main');
  });
  test('patch of a missing row is a no-op', async () => {
    expect(await repo.patch<Account>('accounts', 'nope', { name: 'x' })).toBeUndefined();
  });
  test('remove tombstones; loadState hides it; the row stays on disk', async () => {
    const a = await repo.create<Account>('accounts', draft);
    await repo.remove('accounts', a.id);
    expect((await repo.loadState()).accounts).toEqual([]);
    expect((await db.accounts.get(a.id))!.deleted).toBe(true);
  });
  test('putAssignment upserts by deterministic id and restamps', async () => {
    const first = await repo.putAssignment('cat_groc', '2026-09', 60000);
    const second = await repo.putAssignment('cat_groc', '2026-09', 70000);
    expect(second.id).toBe(first.id);
    expect(second.id).toBe('asg_cat_groc_2026-09');
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
    expect(await db.assignments.count()).toBe(1);
    expect((await repo.loadState()).assignments[0]!.amount).toBe(70000);
  });
  test('settings are sparse on disk and defaulted on read', async () => {
    expect(await repo.getSettings()).toEqual({ currency: 'CAD' });
    const stamp = await repo.updateSettings({ cutoverMonth: '2026-09' });
    expect(stamp).toBeGreaterThan(0);
    expect((await db.kv.get('settings'))!.value).toEqual({ data: { cutoverMonth: '2026-09' }, updatedAt: stamp });
    expect(await repo.getSettings()).toEqual({ currency: 'CAD', cutoverMonth: '2026-09' });
    expect((await repo.loadState()).settingsUpdatedAt).toBe(stamp);
  });
  test('replaceAll keeps the newer copy of each row, never resurrects with an older one, and settings follow their stamp', async () => {
    const a = await repo.create<Account>('accounts', { ...draft, id: 'acc_a' });
    const b = await repo.create<Account>('accounts', { ...draft, id: 'acc_b', name: 'Local newer' });
    await repo.remove('accounts', 'acc_b');   // a local tombstone with a fresh stamp
    const stamp = await repo.updateSettings({ cutoverMonth: '2026-09' });
    const incoming = await repo.loadSnapshot();
    incoming.accounts = [
      { ...a, name: 'Remote newer', updatedAt: a.updatedAt + 1000 },
      { ...b, name: 'Stale remote', deleted: false, updatedAt: b.updatedAt - 1000 },
      { ...a, id: 'acc_c', name: 'Only remote' },
    ];
    incoming.settings = { cutoverMonth: '2026-10' };
    incoming.settingsUpdatedAt = stamp - 1;
    await repo.replaceAll(incoming);
    const s = await repo.loadSnapshot();
    expect(s.accounts.find((x) => x.id === 'acc_a')!.name).toBe('Remote newer');
    expect(s.accounts.find((x) => x.id === 'acc_b')!.deleted).toBe(true);
    expect(s.accounts.some((x) => x.id === 'acc_c')).toBe(true);
    expect(s.settings).toEqual({ cutoverMonth: '2026-09' });
    incoming.settingsUpdatedAt = stamp + 1;
    await repo.replaceAll(incoming);
    expect((await repo.getSettings()).cutoverMonth).toBe('2026-10');
  });

  test('applyBatch never creates over an existing row, tombstoned or live', async () => {
    const a = await repo.create<Account>('accounts', { ...draft, id: 'acc_x' });
    await repo.remove('accounts', 'acc_x');
    const written = await repo.applyBatch([
      { table: 'accounts', id: 'acc_x', create: { ...draft, name: 'Ghost' } },
      { table: 'accounts', id: 'acc_y', create: { ...draft, name: 'Real' } },
    ]);
    expect(written.map((w) => w.row.id)).toEqual(['acc_y']);
    expect((await db.accounts.get('acc_x'))!).toMatchObject({ deleted: true, name: 'Chequing' });
    expect(await repo.existingIds('accounts', ['acc_x', 'acc_y', 'acc_z'])).toEqual(new Set(['acc_x', 'acc_y']));
    void a;
  });

  test('device values are separate from snapshots', async () => {
    await repo.setDevice('syncConfig', { owner: 'o', repo: 'r', token: 't' });
    expect(await repo.getDevice('syncConfig')).toEqual({ owner: 'o', repo: 'r', token: 't' });
    expect(JSON.stringify(await repo.loadSnapshot())).not.toContain('"token"');
    await repo.setDevice('syncConfig', undefined);
    expect(await repo.getDevice('syncConfig')).toBeUndefined();
  });

  test('importRows writes several tables atomically and isEmpty flips', async () => {
    expect(await repo.isEmpty()).toBe(true);
    const c: Category = { id: 'cat_x', groupId: 'g', name: 'X', goal: 0, sortOrder: 0, hidden: false, note: '', updatedAt: 1, deleted: false };
    await repo.importRows({ accounts: [{ ...draft, id: 'acc_a', updatedAt: 1, deleted: false }], categories: [c] });
    expect(await repo.isEmpty()).toBe(false);
    const s = await repo.loadState();
    expect(s.accounts).toHaveLength(1);
    expect(s.categories).toHaveLength(1);
  });
});
