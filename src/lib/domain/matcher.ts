/**
 * Pair incoming statement rows with existing register rows (spec §5.5). Ported
 * from statement_reconcile.py, which scored 186/186 with zero false pairs on
 * real data: exact amount, a directional date window, payee similarity to
 * rank, greedy one-to-one assignment. Never dedupe on field equality alone.
 */
import type { Cents, IsoDate } from './types';

export interface MatchCandidate {
  id: string;
  date: IsoDate;
  amount: Cents;
  name: string;
}

export interface MatchPair {
  incomingId: string;
  existingId: string;
  similarity: number;
  /** incoming.date − existing.date in days; statements usually post 0 to 4 days after the register date. */
  lag: number;
}

export interface MatchOptions {
  minLag?: number;
  maxLag?: number;
}

/** Tokens that carry no merchant identity in Canadian card descriptors. */
const STOPWORDS = new Set([
  'sk', 'on', 'ns', 'bc', 'ab', 'mb', 'qc', 'nb', 'inc', 'ltd', 'the',
  'sq', 'tst', 'ca', 'com', 'bill', 'store', 'restaurant', 'www', 'pos', 'purchase',
  'saskatoon', 'toronto', 'regina', 'vancouver', 'calgary', 'montreal', 'edmonton', 'winnipeg', 'ottawa', 'halifax',
]);

function tokens(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length > 2 && !STOPWORDS.has(w)));
}

/** Ratcliff/Obershelp ratio, as Python's difflib.SequenceMatcher.ratio() computes it. */
function ratio(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const matches = (x: string, y: string): number => {
    let best = 0, bi = 0, bj = 0;
    for (let i = 0; i < x.length; i++) {
      for (let j = 0; j < y.length; j++) {
        let k = 0;
        while (i + k < x.length && j + k < y.length && x[i + k] === y[j + k]) k++;
        if (k > best) { best = k; bi = i; bj = j; }
      }
    }
    if (!best) return 0;
    return best + matches(x.slice(0, bi), y.slice(0, bj)) + matches(x.slice(bi + best), y.slice(bj + best));
  };
  return (2 * matches(a, b)) / (a.length + b.length);
}

/** Payee-name similarity in [0, 1]: any shared meaningful token wins outright; otherwise a fuzzy compare of the first 14 letters, since bank descriptors truncate. */
export function similarity(a: string, b: string): number {
  const ta = tokens(a), tb = tokens(b);
  for (const t of ta) if (tb.has(t)) return 1;
  const na = a.toLowerCase().replace(/[^a-z]/g, '').slice(0, 14);
  const nb = b.toLowerCase().replace(/[^a-z]/g, '').slice(0, 14);
  return ratio(na, nb);
}

const dayNumber = (d: IsoDate) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86400000;

export function matchTransactions(
  incoming: MatchCandidate[],
  existing: MatchCandidate[],
  opts: MatchOptions = {},
): { pairs: MatchPair[]; unmatchedIncoming: string[]; unmatchedExisting: string[] } {
  const minLag = opts.minLag ?? -2;
  const maxLag = opts.maxLag ?? 9;
  const candidates: (MatchPair & { i: number; j: number })[] = [];
  incoming.forEach((s, i) => {
    const sd = dayNumber(s.date);
    existing.forEach((r, j) => {
      if (s.amount !== r.amount) return;
      const lag = sd - dayNumber(r.date);
      if (lag < minLag || lag > maxLag) return;
      candidates.push({ incomingId: s.id, existingId: r.id, similarity: similarity(s.name, r.name), lag, i, j });
    });
  });
  // Highest similarity first, then the smallest lag, then file order so results are stable.
  candidates.sort((a, b) => b.similarity - a.similarity || Math.abs(a.lag) - Math.abs(b.lag) || a.i - b.i || a.j - b.j);
  const usedI = new Set<number>(), usedJ = new Set<number>();
  const pairs: MatchPair[] = [];
  for (const c of candidates) {
    if (usedI.has(c.i) || usedJ.has(c.j)) continue;
    usedI.add(c.i); usedJ.add(c.j);
    pairs.push({ incomingId: c.incomingId, existingId: c.existingId, similarity: c.similarity, lag: c.lag });
  }
  return {
    pairs,
    unmatchedIncoming: incoming.filter((_, i) => !usedI.has(i)).map((s) => s.id),
    unmatchedExisting: existing.filter((_, j) => !usedJ.has(j)).map((r) => r.id),
  };
}
