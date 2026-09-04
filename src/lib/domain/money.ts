import type { Cents } from './types';

/** "1,234.56" / "-0.05". No symbol; the UI decides the symbol. */
export function formatCents(cents: Cents): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${grouped}.${frac}`;
}

/** "$606.55" / "-$42.00". Single currency, so the symbol is fixed. */
export function formatMoney(cents: Cents): string {
  const s = formatCents(cents);
  return s.startsWith('-') ? `-$${s.slice(1)}` : `$${s}`;
}

/**
 * Text to cents by string arithmetic, never via parseFloat: 0.29 * 100 is
 * 28.999999999999996 as a float. Accepts a leading sign or accounting
 * parentheses, an optional $ and thousands separators, up to two decimals.
 * Returns null for anything else, including three decimals.
 */
export function parseCents(text: string): Cents | null {
  let s = text.trim();
  if (!s) return null;
  let neg = false;
  if (s.startsWith('(') && s.endsWith(')')) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  else if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('$')) s = s.slice(1);
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  s = s.replace(/,/g, '');
  const m = /^(\d*)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m || (m[1] === '' && !m[2])) return null;
  const whole = Number(m[1] || '0');
  const frac = Number((m[2] ?? '').padEnd(2, '0'));
  const cents = whole * 100 + frac;
  return neg ? -cents : cents;
}
