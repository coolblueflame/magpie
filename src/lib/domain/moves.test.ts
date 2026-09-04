import { describe, expect, test } from 'vitest';
import { movePatches } from './moves';
import { RTA } from './types';

describe('movePatches', () => {
  const assigned = (id: string) => ({ a: 10000, b: 2000 })[id] ?? 0;
  test('category to category', () => {
    expect(movePatches('a', 'b', '2026-09', 2500, assigned)).toEqual([
      { categoryId: 'a', month: '2026-09', amount: 7500 }, { categoryId: 'b', month: '2026-09', amount: 4500 },
    ]);
  });
  test('to and from Ready to Assign touch one row', () => {
    expect(movePatches(RTA, 'b', '2026-09', 500, assigned)).toEqual([{ categoryId: 'b', month: '2026-09', amount: 2500 }]);
    expect(movePatches('a', RTA, '2026-09', 500, assigned)).toEqual([{ categoryId: 'a', month: '2026-09', amount: 9500 }]);
  });
  test('rejects nonsense', () => {
    expect(() => movePatches('a', 'a', '2026-09', 100, assigned)).toThrow(/same/);
    expect(() => movePatches('a', 'b', '2026-09', 0, assigned)).toThrow(/positive/);
    expect(() => movePatches('a', 'b', '2026-09', 1.5, assigned)).toThrow(/positive/);
  });
});
