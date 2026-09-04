import { describe, expect, test } from 'vitest';
import { addMonths, compareMonths, maxMonth, minMonth, monthKeyOf, monthLabel, monthOf, monthsBetween } from './month';

describe('month keys', () => {
  test('monthOf takes the first seven characters of an ISO date', () => {
    expect(monthOf('2026-09-04')).toBe('2026-09');
  });
  test('addMonths crosses year boundaries both ways', () => {
    expect(addMonths('2026-09', 1)).toBe('2026-10');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-01', -13)).toBe('2024-12');
    expect(addMonths('2026-06', 0)).toBe('2026-06');
  });
  test('monthsBetween is inclusive and empty when reversed', () => {
    expect(monthsBetween('2026-11', '2027-02')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
    expect(monthsBetween('2026-11', '2026-11')).toEqual(['2026-11']);
    expect(monthsBetween('2026-12', '2026-11')).toEqual([]);
  });
  test('compare, min, max are lexicographic', () => {
    expect(compareMonths('2026-09', '2026-10')).toBeLessThan(0);
    expect(maxMonth('2026-09', '2027-01', '2025-12')).toBe('2027-01');
    expect(minMonth('2026-09', '2027-01', '2025-12')).toBe('2025-12');
  });
  test('label and local key', () => {
    expect(monthLabel('2026-09')).toBe('Sep 2026');
    expect(monthKeyOf(new Date(2026, 8, 4, 23, 59))).toBe('2026-09');
  });
});
