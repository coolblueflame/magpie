import { describe, expect, test } from 'vitest';
import { formatCents, formatMoney, parseCents, roundHalfAway } from './money';

describe('formatCents', () => {
  test('groups thousands and always shows two decimals', () => {
    expect(formatCents(0)).toBe('0.00');
    expect(formatCents(5)).toBe('0.05');
    expect(formatCents(123456)).toBe('1,234.56');
    expect(formatCents(-123456)).toBe('-1,234.56');
    expect(formatCents(-5)).toBe('-0.05');
  });
});

describe('roundHalfAway', () => {
  test('halves go away from zero, unlike Math.round', () => {
    expect(roundHalfAway(-500.5)).toBe(-501);
    expect(roundHalfAway(500.5)).toBe(501);
    expect(roundHalfAway(-500.4)).toBe(-500);
    expect(roundHalfAway(0)).toBe(0);
  });
});

describe('formatMoney', () => {
  test('puts the sign before the symbol', () => {
    expect(formatMoney(60655)).toBe('$606.55');
    expect(formatMoney(-4200)).toBe('-$42.00');
  });
});

describe('parseCents', () => {
  test('accepts the shapes people type and files contain', () => {
    expect(parseCents('1,234.56')).toBe(123456);
    expect(parseCents('$1,234.56')).toBe(123456);
    expect(parseCents('-12')).toBe(-1200);
    expect(parseCents('-$12.5')).toBe(-1250);
    expect(parseCents('(12.34)')).toBe(-1234);
    expect(parseCents(' 0.05 ')).toBe(5);
    expect(parseCents('.5')).toBe(50);
  });
  test('rejects what it cannot represent exactly', () => {
    expect(parseCents('')).toBeNull();
    expect(parseCents('abc')).toBeNull();
    expect(parseCents('12.345')).toBeNull();
    expect(parseCents('1.2.3')).toBeNull();
  });
  test('never goes through floating point', () => {
    expect(parseCents('0.29')).toBe(29);
    expect(parseCents('1000000.01')).toBe(100000001);
  });
});
