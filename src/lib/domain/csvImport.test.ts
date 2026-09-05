import { describe, expect, test } from 'vitest';
import { candidatesFromCsv, detectDateFormat, headerSignature, parseDateWith } from './csvImport';
import type { CsvProfile } from './types';

const profile = (over: Partial<CsvProfile> = {}): CsvProfile => ({
  id: 'p1', headerSignature: 'date|description|amount', name: 'Test', dateFormat: 'YYYY-MM-DD',
  mapping: { date: 'Date', payee: 'Description', amount: 'Amount' }, amountMode: 'signed',
  updatedAt: 1, deleted: false, ...over,
});

describe('dates', () => {
  test('each format', () => {
    expect(parseDateWith('YYYY-MM-DD', '2026-09-04')).toBe('2026-09-04');
    expect(parseDateWith('MM/DD/YYYY', '9/4/2026')).toBe('2026-09-04');
    expect(parseDateWith('DD/MM/YYYY', '04/09/2026')).toBe('2026-09-04');
    expect(parseDateWith('MMM D, YYYY', 'Sep 4, 2026')).toBe('2026-09-04');
    expect(parseDateWith('MMM D, YYYY', 'September 4 2026')).toBe('2026-09-04');
    expect(parseDateWith('YYYYMMDD', '20260904')).toBe('2026-09-04');
    expect(parseDateWith('YYYY-MM-DD', 'nope')).toBeNull();
  });
  test('detection prefers unambiguous forms and reads slashes from the values', () => {
    expect(detectDateFormat(['2026-09-04', '2026-09-05'])).toBe('YYYY-MM-DD');
    expect(detectDateFormat(['Apr 9, 2026'])).toBe('MMM D, YYYY');
    expect(detectDateFormat(['13/09/2026', '01/09/2026'])).toBe('DD/MM/YYYY');
    expect(detectDateFormat(['09/13/2026'])).toBe('MM/DD/YYYY');
    expect(detectDateFormat(['01/02/2026'])).toBe('MM/DD/YYYY');
    expect(detectDateFormat(['x'])).toBeNull();
  });
});

describe('candidatesFromCsv', () => {
  test('signed amounts, ordinal ids for identical rows, blank lines skipped', () => {
    const rows = [
      { Date: '2026-09-01', Description: 'Game Store', Amount: '-2.76' },
      { Date: '2026-09-01', Description: 'Game Store', Amount: '-2.76' },
      { Date: '', Description: '', Amount: '' },
      { Date: '2026-09-02', Description: 'Refund', Amount: '$12.00' },
    ];
    const c = candidatesFromCsv(rows, profile(), 'b');
    expect(c).toHaveLength(3);
    expect(c[0]!.externalId).not.toBe(c[1]!.externalId);
    expect(c[0]!.externalId.replace(/:\d+$/, '')).toBe(c[1]!.externalId.replace(/:\d+$/, ''));
    expect(c[2]).toMatchObject({ amount: 1200, descriptor: 'Refund', source: { kind: 'csv', profileId: 'p1' } });
    expect(headerSignature(['Date', ' Description', 'Amount'])).toBe('date|description|amount');
  });
  test('outflow/inflow, negate, id column, missing column errors', () => {
    const io = profile({ mapping: { date: 'D', payee: 'P', outflow: 'Out', inflow: 'In', id: 'Ref' }, amountMode: 'outflow-inflow', dateFormat: 'MM/DD/YYYY' });
    const c = candidatesFromCsv([{ D: '09/04/2026', P: 'Shop', Out: '10.00', In: '', Ref: 'A1' }, { D: '09/05/2026', P: 'Pay', Out: '', In: '100', Ref: 'A2' }], io, 'b');
    expect(c.map((x) => [x.externalId, x.amount])).toEqual([['csv:A1', -1000], ['csv:A2', 10000]]);
    const neg = profile({ amountMode: 'negate' });
    expect(candidatesFromCsv([{ Date: '2026-09-04', Description: 'x', Amount: '5.00' }], neg, 'b')[0]!.amount).toBe(-500);
    expect(() => candidatesFromCsv([{ Date: '2026-09-04', Description: 'x' }], profile(), 'b')).toThrow(/"Amount" is not in this file/);
    expect(() => candidatesFromCsv([{ Date: 'bad', Description: 'x', Amount: '1' }], profile(), 'b')).toThrow(/row 2/);
  });
});
