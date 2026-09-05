/**
 * The shared-expense sheet export (spec §5.4). The header is recognised by
 * shape, never by the names in it: two "<name> Paid" columns followed by a
 * "<initial>'s %" column. Only rows with a date are real; the sheet is padded
 * with formula rows. The percent column, by the sheet's convention, is the
 * share of the SECOND person named.
 */
import type { ImportCandidate, ImportState, PlanEdit } from './importPlan';
import { planImport } from './importPlan';
import { matchTransactions } from './matcher';
import { parseCents } from './money';
import { parseDateWith } from './csvImport';
import { sharedLines, shareSplit } from './shares';
import type { Account, Cents, IsoDate, ShareClaim, Transaction } from './types';
import { fnv1a } from './ynab';

export interface SheetColumns {
  date: number;
  paid: [number, number];
  percent: number;
  where: number;
  what: number;
}

export function isSheetHeader(header: string[]): SheetColumns | null {
  const h = header.map((x) => x.trim().toLowerCase());
  for (let i = 0; i + 2 < h.length; i++) {
    if (h[i]!.endsWith(' paid') && h[i + 1]!.endsWith(' paid') && h[i + 2]!.endsWith('%')) {
      const where = h.indexOf('where');
      const what = h.indexOf('what');
      return {
        date: 0, paid: [i, i + 1], percent: i + 2,
        where: where >= 0 ? where : i + 3,
        what: what >= 0 ? what : i + 4,
      };
    }
  }
  return null;
}

export interface SheetRow {
  key: string;
  date: IsoDate;
  /** What the user paid, positive cents. */
  mine: Cents;
  /** What the partner paid, positive cents. */
  theirs: Cents;
  /** The partner's share of the total, 0..100. */
  percent: number;
  where: string;
  what: string;
}

function money(s: string | undefined): Cents {
  return parseCents((s ?? '').trim() || '0') ?? 0;
}

function parseDate(s: string): IsoDate | null {
  for (const f of ['MMM D, YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY'] as const) {
    const d = parseDateWith(f, s);
    if (d) return d;
  }
  return null;
}

/** Real rows only: those with a date, minus carry-over lines. `mineFirst` says which Paid column is the user's. */
export function parseSheet(rows: string[][], mineFirst: boolean): SheetRow[] {
  const cols = rows[0] ? isSheetHeader(rows[0]) : null;
  if (!cols) throw new Error('This is not a shared expense sheet export.');
  const out: SheetRow[] = [];
  const seen = new Map<string, number>();
  for (const r of rows.slice(1)) {
    const date = parseDate(r[cols.date] ?? '');
    if (!date) continue;
    const where = (r[cols.where] ?? '').trim();
    if (/carry.?over/i.test(where)) continue;
    const first = money(r[cols.paid[0]]);
    const second = money(r[cols.paid[1]]);
    const pctRaw = parseFloat((r[cols.percent] ?? '').replace('%', '').trim() || '0');
    const secondPct = Number.isFinite(pctRaw) ? pctRaw : 0;
    const mine = mineFirst ? first : second;
    const theirs = mineFirst ? second : first;
    const percent = mineFirst ? secondPct : 100 - secondPct;
    if (mine === 0 && theirs === 0) continue;
    const what = (r[cols.what] ?? '').trim();
    const base = fnv1a([date, mine, theirs, percent, where, what].join('|'));
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({ key: `${base}:${n}`, date, mine, theirs, percent, where, what });
  }
  return out;
}

export interface SheetPlan {
  /** Claims to create for rows the user paid. */
  claims: ShareClaim[];
  /** Rows the partner paid entirely: the user's share, as transactions in the person account. */
  partnerPaid: ImportCandidate[];
  skipped: number;
  edits: PlanEdit[];
}

/**
 * Rows the sheet contributes: claims for what the user paid, person-account rows for what
 * the partner paid. Idempotent by row key. Rows before the cutover are skipped: that
 * history already came in with the YNAB import (spec §5.4).
 */
export function planSheet(rows: SheetRow[], personAccountId: string, state: ImportState & { claims: ShareClaim[] }, now: number, ids: () => string, cutoverMonth?: string): SheetPlan {
  const knownClaims = new Set(state.claims.filter((c) => !c.deleted).map((c) => c.id));
  const claims: ShareClaim[] = [];
  const partnerPaid: ImportCandidate[] = [];
  let skipped = 0;
  for (const r of rows) {
    if (cutoverMonth && r.date.slice(0, 7) < cutoverMonth) { skipped++; continue; }
    const total = r.mine + r.theirs;
    if (r.mine === 0) {
      const { mine } = shareSplit(total, r.percent);
      if (mine === 0) { skipped++; continue; }
      partnerPaid.push({ externalId: `sheet:${r.key}`, date: r.date, amount: -mine, descriptor: r.where, memo: r.what, source: { kind: 'sheet', batchId: `sheet-${now}` } });
      continue;
    }
    const id = `claim_${r.key}`;
    if (knownClaims.has(id)) { skipped++; continue; }
    claims.push({
      id, updatedAt: now, editedAt: now, deleted: false, date: r.date, total, paid: r.mine, percent: r.percent,
      description: r.where, ...(r.what ? { categoryHint: r.what } : {}), status: 'open',
    });
  }
  const created = planImport(partnerPaid, personAccountId, state, ids);
  skipped += created.skipped.length;
  const edits: PlanEdit[] = [
    ...claims.map((c) => { const { id, updatedAt, editedAt, deleted, ...rest } = c; void updatedAt; void editedAt; void deleted; return { table: 'claims' as const, id, create: rest as Record<string, unknown> }; }),
    ...created.edits,
  ];
  return { claims, partnerPaid: created.created, skipped, edits };
}

export interface ClaimsPlan {
  applied: { claimId: string; txId: string }[];
  edits: PlanEdit[];
}

/**
 * Pair open claims with bank rows the user paid (same amount as the claim's
 * `paid`, within the posting window, similar descriptor) and split them.
 */
export function planClaims(openClaims: ShareClaim[], transactions: Transaction[], accountsById: Map<string, Account>, personAccountId: string, payeeName: (id?: string) => string, cutoverMonth?: string): ClaimsPlan {
  const eligible = transactions.filter((t) => {
    const a = accountsById.get(t.accountId);
    if (cutoverMonth && t.date.slice(0, 7) < cutoverMonth) return false;
    return !t.deleted && a?.onBudget && a.kind !== 'person' && t.lines.length === 1 && !t.lines[0]!.transferAccountId && !t.shared;
  });
  const { pairs } = matchTransactions(
    eligible.map((t) => ({ id: t.id, date: t.date, amount: t.amount, name: payeeName(t.payeeId) || t.memo })),
    openClaims.filter((c) => c.status === 'open').map((c) => ({ id: c.id, date: c.date, amount: -c.paid, name: c.description })),
  );
  const claimsById = new Map(openClaims.map((c) => [c.id, c]));
  const txById = new Map(eligible.map((t) => [t.id, t]));
  const applied: ClaimsPlan['applied'] = [];
  const edits: PlanEdit[] = [];
  for (const p of pairs) {
    const tx = txById.get(p.incomingId)!;
    const claim = claimsById.get(p.existingId)!;
    const categoryId = tx.lines[0]!.categoryId;
    const lines = sharedLines(tx.amount, claim.total, claim.percent, categoryId, personAccountId);
    const needsCategory = lines.some((l) => !l.transferAccountId && !l.categoryId);
    edits.push({ table: 'transactions', id: tx.id, patch: { lines, shared: { accountId: personAccountId, percent: claim.percent, total: claim.total }, status: needsCategory ? 'new' : 'ok' } });
    edits.push({ table: 'claims', id: claim.id, patch: { status: 'applied', transactionId: tx.id } });
    applied.push({ claimId: claim.id, txId: tx.id });
  }
  return { applied, edits };
}
