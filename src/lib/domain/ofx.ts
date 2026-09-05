/**
 * OFX 1.x SGML statements (QFX from Canadian banks): headers, then unclosed
 * tags. Regex extraction is the right tool here, not an XML parser (CLAUDE.md
 * domain notes). The file's own LEDGERBAL can be stale; it is returned as a
 * cross-check, never as truth.
 */
import { parseCents } from './money';
import { fnv1a } from './ynab';
import type { Cents, IsoDate } from './types';

export interface OfxTxn {
  date: IsoDate;
  amount: Cents;
  /** The bank's unique id for the row; the dedup key across imports. */
  fitid: string;
  name: string;
  memo: string;
  trntype: string;
  /** What to show and match on: NAME, else MEMO, else the type. */
  descriptor: string;
}

export interface OfxStatement {
  transactions: OfxTxn[];
  ledgerBalance?: Cents;
  ledgerDate?: IsoDate;
  /** fnv1a of BANKID|ACCTID; identifies the account without keeping its number. */
  accountRef?: string;
  accountType?: string;
  currency?: string;
  start?: IsoDate;
  end?: IsoDate;
}

export function isOfx(text: string): boolean {
  const head = text.slice(0, 4000);
  return /^OFXHEADER:/m.test(head) || /<OFX>/.test(head);
}

/** The charset the SGML header declares; Canadian banks say CHARSET:1252. */
export function ofxCharset(head: string): string {
  const cs = /CHARSET:(\S+)/.exec(head)?.[1];
  const enc = /ENCODING:(\S+)/.exec(head)?.[1];
  if (cs === '1252') return 'windows-1252';
  if (enc && /utf-?8/i.test(enc)) return 'utf-8';
  return cs ? `windows-${cs}` : 'utf-8';
}

export function decodeOfx(bytes: ArrayBuffer): string {
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 400));
  try { return new TextDecoder(ofxCharset(head)).decode(bytes); }
  catch { return new TextDecoder('latin1').decode(bytes); }
}

function fieldOf(block: string, tag: string): string | undefined {
  // SGML tags are unclosed; the value runs to the end of the line or the next tag.
  const m = new RegExp(`<${tag}>([^\\r\\n<]*)`).exec(block);
  return m ? m[1]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : undefined;
}

function isoDate(v: string | undefined): IsoDate | undefined {
  const m = v && /^(\d{4})(\d{2})(\d{2})/.exec(v);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}

function cents(v: string | undefined): Cents | undefined {
  if (v === undefined) return undefined;
  const c = parseCents(v);
  return c === null ? undefined : c;
}

export function parseOfx(text: string): OfxStatement {
  const transactions: OfxTxn[] = [];
  for (const block of text.matchAll(/<STMTTRN>(.*?)<\/STMTTRN>/gs)) {
    const b = block[1]!;
    const date = isoDate(fieldOf(b, 'DTPOSTED'));
    const amount = cents(fieldOf(b, 'TRNAMT'));
    const fitid = fieldOf(b, 'FITID');
    if (!date || amount === undefined || !fitid) continue;
    const name = fieldOf(b, 'NAME') ?? '';
    const memo = fieldOf(b, 'MEMO') ?? '';
    const trntype = fieldOf(b, 'TRNTYPE') ?? '';
    transactions.push({ date, amount, fitid, name, memo, trntype, descriptor: name || memo || trntype });
  }
  const ledger = /<LEDGERBAL>([\s\S]*?)<\/LEDGERBAL>/.exec(text)?.[1] ?? '';
  const acctFrom = /<(?:BANK|CC)ACCTFROM>([\s\S]*?)<\/(?:BANK|CC)ACCTFROM>/.exec(text)?.[1] ?? '';
  const acctId = fieldOf(acctFrom, 'ACCTID');
  const out: OfxStatement = { transactions };
  const bal = cents(fieldOf(ledger, 'BALAMT'));
  if (bal !== undefined) out.ledgerBalance = bal;
  const balDate = isoDate(fieldOf(ledger, 'DTASOF'));
  if (balDate) out.ledgerDate = balDate;
  if (acctId) out.accountRef = fnv1a(`${fieldOf(acctFrom, 'BANKID') ?? ''}|${acctId}`);
  const type = fieldOf(acctFrom, 'ACCTTYPE');
  if (type) out.accountType = type;
  const cur = fieldOf(text, 'CURDEF');
  if (cur) out.currency = cur;
  const start = isoDate(fieldOf(text, 'DTSTART'));
  if (start) out.start = start;
  const end = isoDate(fieldOf(text, 'DTEND'));
  if (end) out.end = end;
  return out;
}
