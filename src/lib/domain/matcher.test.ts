import { describe, expect, test } from 'vitest';
import { matchTransactions, similarity } from './matcher';

describe('similarity', () => {
  test('shared meaningful tokens win outright; stopwords and short tokens do not count', () => {
    expect(similarity('SQ *COFFEE CO SASKATOON SK', 'Coffee Co')).toBe(1);
    expect(similarity('THE STORE SK', 'THE BILL ON')).toBeLessThan(1);
  });
  test('fuzzy fallback on truncated descriptors', () => {
    expect(similarity('GROCERMART#12', 'Grocer Mart')).toBeGreaterThan(0.8);
    expect(similarity('ABCDEFG', 'ZYXWVUT')).toBe(0);
  });
});

describe('matchTransactions', () => {
  const inc = (id: string, date: string, amount: number, name: string) => ({ id, date, amount, name });
  test('amount must be exact and the window is directional', () => {
    const r = matchTransactions(
      [inc('s1', '2026-09-05', -1000, 'Shop'), inc('s2', '2026-09-05', -1001, 'Shop'), inc('s3', '2026-09-20', -2000, 'Late'), inc('s4', '2026-09-01', -3000, 'Early')],
      [inc('r1', '2026-09-03', -1000, 'Shop'), inc('r2', '2026-09-03', -2000, 'Late'), inc('r3', '2026-09-04', -3000, 'Early')],
    );
    expect(r.pairs).toEqual([{ incomingId: 's1', existingId: 'r1', similarity: 1, lag: 2 }]);
    expect(r.unmatchedIncoming).toEqual(['s2', 's3', 's4']);
    expect(r.unmatchedExisting).toEqual(['r2', 'r3']);
  });
  test('the more similar name wins a contested row; identical repeats pair one-to-one', () => {
    const r = matchTransactions(
      [inc('a', '2026-09-05', -276, 'GAME STORE ONLINE'), inc('b', '2026-09-05', -276, 'GAME STORE ONLINE'), inc('c', '2026-09-05', -500, 'PIZZA PLACE')],
      [inc('x', '2026-09-04', -276, 'Game Store'), inc('y', '2026-09-04', -276, 'Game Store'), inc('z', '2026-09-04', -500, 'Sushi Bar'), inc('w', '2026-09-05', -500, 'Pizza Place')],
    );
    expect(r.pairs.filter((p) => p.similarity === 1)).toHaveLength(3);
    expect(new Set(r.pairs.map((p) => p.existingId)).size).toBe(3);
    expect(r.pairs.find((p) => p.incomingId === 'c')!.existingId).toBe('w');
    expect(r.unmatchedExisting).toEqual(['z']);
  });
  test('ties in similarity go to the smaller lag', () => {
    const r = matchTransactions(
      [inc('s', '2026-09-10', -900, 'Nothing Alike')],
      [inc('far', '2026-09-02', -900, 'Different Words'), inc('near', '2026-09-09', -900, 'Other Text')],
    );
    expect(r.pairs[0]!.existingId).toBe('near');
  });
});
