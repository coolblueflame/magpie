import { describe, expect, test } from 'vitest';
import { categoryStats } from './stats';

describe('categoryStats', () => {
  test('all-time and trailing windows differ on a long history', () => {
    // 14 months: 2025-07 .. 2026-08, each -1000 except 2025-07 and 2025-08 at -10000.
    const m = new Map<string, number>();
    for (const ym of ['2025-07', '2025-08']) m.set(ym, -10000);
    for (const ym of ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']) m.set(ym, -1000);
    const s = categoryStats(m, '2026-09');
    expect(s.firstMonth).toBe('2025-07');
    expect(s.allTimeAvg).toBe(Math.round(-32000 / 14));
    expect(s.trailing12Avg).toBe(-1000);
    expect(s.lastMonth).toBe(-1000);
  });
  test('a two-month-old category divides by two, and gaps count as zero months', () => {
    const s = categoryStats(new Map([['2026-06', -30000], ['2026-08', -10000]]), '2026-09');
    expect(s.allTimeAvg).toBe(Math.round(-40000 / 3));
    expect(s.trailing12Avg).toBe(Math.round(-40000 / 3));
    expect(s.lastMonth).toBe(-10000);
  });
  test('the current month is ignored; no history gives nulls', () => {
    expect(categoryStats(new Map([['2026-09', -500]]), '2026-09')).toEqual({ allTimeAvg: null, trailing12Avg: null, lastMonth: 0, firstMonth: null });
    expect(categoryStats(undefined, '2026-09')).toEqual({ allTimeAvg: null, trailing12Avg: null, lastMonth: 0, firstMonth: null });
  });
  test('rounding is symmetric around zero', () => {
    expect(categoryStats(new Map([['2026-07', -1001], ['2026-08', 0]]), '2026-09').allTimeAvg).toBe(-501);
    expect(categoryStats(new Map([['2026-07', 1001], ['2026-08', 0]]), '2026-09').allTimeAvg).toBe(501);
  });
});
