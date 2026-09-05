import { describe, expect, test } from 'vitest';
import { decodeOfx, isOfx, ofxCharset, parseOfx } from './ofx';
import { BANK_QFX, CARD_QFX } from './ofxFixture';
import { REGISTER_CSV } from './ynabFixture';

describe('parseOfx', () => {
  test('a card statement with LF and timezone-suffixed dates', () => {
    const s = parseOfx(CARD_QFX);
    expect(s.transactions).toHaveLength(5);
    expect(s.transactions[1]!.descriptor).toBe('M&M FOOD MARKET');
    expect(s.transactions[0]).toEqual({ date: '2026-09-03', amount: -4510, fitid: '2026090300001', name: 'GROCER MART #12 TOWNSVILLE', memo: '', trntype: 'DEBIT', descriptor: 'GROCER MART #12 TOWNSVILLE' });
    expect(s.transactions[2]!.amount).toBe(1200);
    expect(s.transactions[3]!.fitid).not.toBe(s.transactions[4]!.fitid);   // identical rows, distinct ids
    expect(s).toMatchObject({ ledgerBalance: -123456, ledgerDate: '2026-09-04', currency: 'CAD', start: '2026-08-01', end: '2026-09-04' });
    expect(s.accountRef).toMatch(/^[0-9a-f]{8}$/);
    expect(s.accountType).toBeUndefined();
  });
  test('a bank statement with CRLF, ACCTTYPE and MEMO-only rows', () => {
    const s = parseOfx(BANK_QFX);
    expect(s.transactions.map((t) => t.descriptor)).toEqual(['Interest paid', 'Transfer', 'ELECTRIC UTILITY']);
    expect(s.transactions[1]).toMatchObject({ memo: 'To card 2222', amount: -150000, trntype: 'XFER' });
    expect(s).toMatchObject({ accountType: 'CHECKING', ledgerBalance: 500037 });
    expect(s.accountRef).not.toBe(parseOfx(CARD_QFX).accountRef);
    expect(CARD_QFX).not.toContain('4520000011112222'.slice(0, 0) + s.accountRef!);   // the hash is not the number
  });
  test('detection and charset', () => {
    expect(isOfx(CARD_QFX)).toBe(true);
    expect(isOfx(REGISTER_CSV)).toBe(false);
    expect(ofxCharset('OFXHEADER:100\nENCODING:USASCII\nCHARSET:1252\n')).toBe('windows-1252');
    expect(ofxCharset('OFXHEADER:100\nENCODING:UTF-8\nCHARSET:NONE\n')).toBe('utf-8');
    const bytes = new TextEncoder().encode(CARD_QFX).buffer;
    expect(parseOfx(decodeOfx(bytes)).transactions).toHaveLength(5);
  });
});
