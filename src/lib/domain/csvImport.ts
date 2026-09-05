/**
 * CSV statements through a saved column profile (spec §5.3). Institutions are
 * never named in code: a profile is keyed by the file's header signature and
 * remembers which columns mean what.
 */
import type { ImportCandidate } from './importPlan';
import { parseCents } from './money';
import type { CsvProfile, IsoDate } from './types';
import { fnv1a } from './ynab';

export const DATE_FORMATS = ['YYYY-MM-DD', 'MM/DD/YYYY', 'DD/MM/YYYY', 'MMM D, YYYY', 'YYYYMMDD'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: string | number) => String(n).padStart(2, '0');

export function headerSignature(header: string[]): string {
  return header.map((h) => h.trim().toLowerCase()).join('|');
}

export function parseDateWith(format: string, s: string): IsoDate | null {
  const t = s.trim();
  let m: RegExpExecArray | null;
  switch (format) {
    case 'YYYY-MM-DD': return (m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t)) ? `${m[1]}-${pad(m[2]!)}-${pad(m[3]!)}` : null;
    case 'MM/DD/YYYY': return (m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t)) ? `${m[3]}-${pad(m[1]!)}-${pad(m[2]!)}` : null;
    case 'DD/MM/YYYY': return (m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t)) ? `${m[3]}-${pad(m[2]!)}-${pad(m[1]!)}` : null;
    case 'YYYYMMDD': return (m = /^(\d{4})(\d{2})(\d{2})$/.exec(t)) ? `${m[1]}-${m[2]}-${m[3]}` : null;
    case 'MMM D, YYYY': {
      m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/.exec(t);
      const mi = m ? MONTHS.indexOf(m[1]!.toLowerCase()) : -1;
      return m && mi >= 0 ? `${m[3]}-${pad(mi + 1)}-${pad(m[2]!)}` : null;
    }
    default: return null;
  }
}

/** The first format every sample parses with; between the two slash forms, whichever the values allow. */
export function detectDateFormat(samples: string[]): DateFormat | null {
  const vals = samples.map((s) => s.trim()).filter(Boolean);
  if (!vals.length) return null;
  const fits = (f: DateFormat) => vals.every((v) => parseDateWith(f, v) !== null);
  for (const f of ['YYYY-MM-DD', 'YYYYMMDD', 'MMM D, YYYY'] as const) if (fits(f)) return f;
  if (fits('MM/DD/YYYY') || fits('DD/MM/YYYY')) {
    const firstOver12 = vals.some((v) => Number(v.split('/')[0]) > 12);
    const secondOver12 = vals.some((v) => Number(v.split('/')[1]) > 12);
    if (firstOver12 && !secondOver12) return 'DD/MM/YYYY';
    return 'MM/DD/YYYY';
  }
  return null;
}

function cell(row: Record<string, string>, column: string | undefined, what: string): string {
  if (!column) throw new Error(`the profile has no ${what} column`);
  if (!(column in row)) throw new Error(`column "${column}" is not in this file`);
  return row[column] ?? '';
}

export function candidatesFromCsv(rows: Record<string, string>[], profile: CsvProfile, batchId: string): ImportCandidate[] {
  const m = profile.mapping;
  const seen = new Map<string, number>();
  const out: ImportCandidate[] = [];
  rows.forEach((row, i) => {
    const dateText = cell(row, m.date, 'date');
    const payee = cell(row, m.payee, 'payee').trim();
    const memo = m.memo ? (row[m.memo] ?? '').trim() : '';
    if (!dateText.trim() && !payee) return; // a blank line
    const date = parseDateWith(profile.dateFormat, dateText);
    if (!date) throw new Error(`row ${i + 2}: cannot read the date "${dateText}" as ${profile.dateFormat}`);
    let amount: number | null;
    if (profile.amountMode === 'outflow-inflow') {
      const outflow = parseCents(cell(row, m.outflow, 'outflow') || '0') ?? 0;
      const inflow = parseCents(cell(row, m.inflow, 'inflow') || '0') ?? 0;
      amount = inflow - outflow;
    } else {
      amount = parseCents(cell(row, m.amount, 'amount'));
      if (amount === null) throw new Error(`row ${i + 2}: cannot read the amount`);
      if (profile.amountMode === 'negate') amount = -amount;
    }
    let externalId: string;
    if (m.id && row[m.id]) externalId = `csv:${row[m.id]!.trim()}`;
    else {
      const base = fnv1a([date, amount, payee, memo].join('|'));
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      externalId = `csv:${base}:${n}`;
    }
    out.push({ externalId, date, amount, descriptor: payee, memo, source: { kind: 'csv', profileId: profile.id, batchId } });
  });
  return out;
}
