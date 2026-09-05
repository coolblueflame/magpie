import { describe, expect, test } from 'vitest';
import { canonical, mergeSnapshots, pick, supersedes } from './merge';
import { fromFiles } from './files';
import { fullSnapshot } from './fixtures';
import type { Row } from '../domain/types';

const row = (over: Partial<Row & { name?: string }> = {}): Row & { name?: string } => ({ id: 'x', updatedAt: 100, deleted: false, ...over });

describe('pick', () => {
  test('newer stamp wins regardless of side', () => {
    const a = row({ updatedAt: 200 }), b = row({ updatedAt: 100 });
    expect(pick(a, b)).toBe(a);
    expect(pick(b, a)).toBe(a);
  });
  test('tie: tombstone, then editedAt, then canonical content', () => {
    const live = row(), dead = row({ deleted: true });
    expect(pick(live, dead)).toBe(dead);
    const early = row({ editedAt: 5, name: 'b' }), late = row({ editedAt: 9, name: 'a' });
    expect(pick(early, late)).toBe(late);
    const withClock = row({ editedAt: 1 }), without = row();
    expect(pick(without, withClock)).toBe(withClock);
    const p = row({ name: 'apple' }), q = row({ name: 'banana' });
    expect(pick(p, q)).toBe(pick(q, p));
  });
  test('supersedes is pick from the storage side', () => {
    expect(supersedes(row({ updatedAt: 200 }), row({ updatedAt: 100 }))).toBe(true);
    expect(supersedes(row({ updatedAt: 100 }), row({ updatedAt: 200 }))).toBe(false);
  });
});

describe('mergeSnapshots', () => {
  test('rows on either side survive; newer wins; flags say who must act', () => {
    const local = fullSnapshot();
    const remote = fromFiles({});
    const r = mergeSnapshots(local, remote);
    expect(r.localChanged).toBe(false);
    expect(r.remoteChanged).toBe(true);
    expect(canonical(r.merged)).toBe(canonical(local));
    const r2 = mergeSnapshots(local, local);
    expect(r2).toMatchObject({ localChanged: false, remoteChanged: false });
  });
  test('key order is layout, not content', () => {
    const local = fullSnapshot();
    const reordered = JSON.parse(JSON.stringify(local)) as typeof local;
    reordered.accounts = reordered.accounts.map((a) => { const { name, ...rest } = a; return { ...rest, name }; });
    expect(mergeSnapshots(local, reordered)).toMatchObject({ localChanged: false, remoteChanged: false });
  });
  test('a remote edit and a local edit to different rows both propagate', () => {
    const local = fullSnapshot();
    const remote = JSON.parse(JSON.stringify(local)) as typeof local;
    remote.payees[0] = { ...remote.payees[0]!, name: 'Grocer Co', updatedAt: remote.payees[0]!.updatedAt + 1 };
    local.categories[0] = { ...local.categories[0]!, goal: 70000, updatedAt: local.categories[0]!.updatedAt + 1 };
    const r = mergeSnapshots(local, remote);
    expect(r.merged.payees[0]!.name).toBe('Grocer Co');
    expect(r.merged.categories[0]!.goal).toBe(70000);
    expect(r).toMatchObject({ localChanged: true, remoteChanged: true });
    expect(canonical(mergeSnapshots(remote, local).merged)).toBe(canonical(r.merged));
  });
  test('settings merge by stamp, and a newer tombstone beats a live row', () => {
    const local = fullSnapshot();
    const remote = JSON.parse(JSON.stringify(local)) as typeof local;
    remote.settings = { cutoverMonth: '2026-10' };
    remote.settingsUpdatedAt = local.settingsUpdatedAt + 1;
    remote.accounts[0] = { ...remote.accounts[0]!, deleted: true, updatedAt: remote.accounts[0]!.updatedAt + 1 };
    const r = mergeSnapshots(local, remote);
    expect(r.merged.settings).toEqual({ cutoverMonth: '2026-10' });
    expect(r.merged.accounts[0]!.deleted).toBe(true);
  });
  test('property: merge is commutative and idempotent over random rows', () => {
    let seed = 42;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let trial = 0; trial < 50; trial++) {
      const make = () => Array.from({ length: 6 }, (_, i) => ({ id: `r${i % 4}`, updatedAt: 100 + Math.floor(rnd() * 3), deleted: rnd() < 0.3, editedAt: Math.floor(rnd() * 3), name: String(Math.floor(rnd() * 3)) }));
      const uniq = (rows: ReturnType<typeof make>) => [...new Map(rows.map((r) => [r.id, r])).values()];
      const a = { ...fromFiles({}), payees: uniq(make()) as never }, b = { ...fromFiles({}), payees: uniq(make()) as never };
      const ab = mergeSnapshots(a, b).merged, ba = mergeSnapshots(b, a).merged;
      expect(canonical(ab.payees)).toBe(canonical([...ba.payees].sort((x, y) => (x.id < y.id ? -1 : 1))) === canonical([...ab.payees].sort((x, y) => (x.id < y.id ? -1 : 1))) ? canonical(ab.payees) : 'differs');
      expect(mergeSnapshots(ab, ab)).toMatchObject({ localChanged: false, remoteChanged: false });
    }
  });
});
