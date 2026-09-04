import { describe, expect, test } from 'vitest';
import { fillPatches, suggestGoal } from './goals';
import type { Category } from './types';

describe('suggestGoal', () => {
  test('the most frequent non-zero amount within twelve months', () => {
    const m = new Map([['2026-07', 60000], ['2026-08', 60000], ['2026-09', 70000], ['2025-01', 99999], ['2026-06', 0]]);
    expect(suggestGoal(m, '2026-09')).toBe(60000);
  });
  test('ties go to the most recent amount', () => {
    expect(suggestGoal(new Map([['2026-07', 100], ['2026-08', 200]]), '2026-09')).toBe(200);
  });
  test('months older than twelve and future months are ignored; nothing gives null', () => {
    expect(suggestGoal(new Map([['2025-09', 100], ['2026-10', 300]]), '2026-09')).toBeNull();
    expect(suggestGoal(new Map([['2025-10', 100]]), '2026-09')).toBe(100);
    expect(suggestGoal(undefined, '2026-09')).toBeNull();
  });
});

describe('fillPatches', () => {
  const cat = (id: string, goal: number, hidden = false): Category =>
    ({ id, groupId: 'g', name: id, goal, sortOrder: 0, hidden, note: '', updatedAt: 1, deleted: false });
  test('skips hidden, goalless and already-filled categories; totals the shortfall', () => {
    const assigned: Record<string, number> = { a: 1000, b: 5000, c: 0, d: 0 };
    const r = fillPatches([cat('a', 4000), cat('b', 5000), cat('c', 0), cat('d', 2500, true), cat('e', 1000)], (id) => assigned[id] ?? 0, '2026-09');
    expect(r.patches).toEqual([{ categoryId: 'a', month: '2026-09', amount: 4000 }, { categoryId: 'e', month: '2026-09', amount: 1000 }]);
    expect(r.total).toBe(3000 + 1000);
  });
});
