/**
 * RFC 4180 CSV: quoted fields may contain commas, newlines and doubled
 * quotes; rows end in LF or CRLF; a leading BOM is ignored. No header
 * handling here; see csvObjects.
 */
export function parseCsv(text: string): string[][] {
  const src = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  // A final row without a trailing newline; a trailing newline leaves nothing behind.
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** First row as keys. Rows shorter than the header get '' for the missing keys. */
export function csvObjects(text: string): Record<string, string>[] {
  const [header, ...rest] = parseCsv(text);
  if (!header) return [];
  return rest.map((r) => Object.fromEntries(header.map((k, i) => [k, r[i] ?? ''])));
}
