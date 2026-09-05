/**
 * The import pipeline's resolution step (spec §5): for each candidate row from
 * a file, decide skip / match / create against one account, and produce the
 * edits that realise it. Pure; the store applies the edits as one undo entry.
 */
import { nanoid } from 'nanoid';
import { ledgerRows } from './ledger';
import { matchTransactions } from './matcher';
import { normalisePayeeKey } from './payees';
import type { Account, Cents, IsoDate, Payee, Row, Transaction, TxSource } from './types';

export interface ImportCandidate {
  /** Stable id from the file (a FITID, a CSV id column, or a row hash). */
  externalId: string;
  date: IsoDate;
  amount: Cents;
  descriptor: string;
  memo: string;
  source: TxSource;
}

export interface ImportState {
  transactions: Transaction[];
  payees: Payee[];
  accountsById: Map<string, Account>;
}

/** Mirrors the store's Edit type without importing the store into the domain. */
export type PlanEdit =
  | { table: 'transactions' | 'payees' | 'claims' | 'accounts'; id: string; patch: Partial<Row> & Record<string, unknown> }
  | { table: 'transactions' | 'payees' | 'claims'; id: string; create: Record<string, unknown> };

export interface ImportPlan {
  accountId: string;
  skipped: ImportCandidate[];
  matched: { candidate: ImportCandidate; txId: string; side: 'own' | 'far'; lineIndex?: number }[];
  created: ImportCandidate[];
  payeesToCreate: { id: string; name: string }[];
  edits: PlanEdit[];
  summary: string;
}

/** Existing payee by name or alias key, tracking ones created earlier in the same plan. */
export class PayeeResolver {
  private byKey = new Map<string, string>();
  created: { id: string; name: string; key: string }[] = [];
  constructor(payees: Payee[], private ids: () => string = nanoid) {
    for (const p of payees) {
      if (p.deleted) continue;
      this.byKey.set(normalisePayeeKey(p.name), p.id);
      for (const a of p.aliases) this.byKey.set(a, p.id);
    }
  }
  resolve(descriptor: string): string | undefined {
    const key = normalisePayeeKey(descriptor);
    if (!key) return undefined;
    const found = this.byKey.get(key);
    if (found) return found;
    const id = this.ids();
    this.byKey.set(key, id);
    this.created.push({ id, name: descriptor.trim().replace(/\s+/g, ' '), key });
    return id;
  }
  createEdits(): PlanEdit[] {
    return this.created.map((c) => ({ table: 'payees', id: c.id, create: { name: c.name, aliases: [c.key], note: '' } }));
  }
}

/** Ids minted from a bank's own data (statement, CSV, sheet row); a YNAB row hash is not one. */
export const isBankSideId = (id: string | undefined): boolean => !!id && !id.startsWith('ynab:');

export function planImport(candidates: ImportCandidate[], accountId: string, state: ImportState, ids: () => string = nanoid): ImportPlan {
  const account = state.accountsById.get(accountId);
  if (!account) throw new Error(`unknown account ${accountId}`);
  const payeeName = (id?: string) => (id ? state.payees.find((p) => p.id === id)?.name ?? '' : '');

  // Ids this account already holds, on either side of its rows.
  const known = new Set<string>();
  for (const tx of state.transactions) {
    if (tx.deleted) continue;
    if (tx.accountId === accountId && tx.externalId) known.add(tx.externalId);
    for (const l of tx.lines) if (l.transferAccountId === accountId && l.farExternalId) known.add(l.farExternalId);
  }
  const skipped = candidates.filter((c) => known.has(c.externalId));
  const pending = candidates.filter((c) => !known.has(c.externalId));

  // Rows of this ledger with no bank-side id yet are what a file row may be. A
  // YNAB row hash (ynab:) is traceability, not a bank id: a statement row can
  // still be that row's twin, and linking it replaces the hash with the bank id.
  const txById = new Map(state.transactions.map((t) => [t.id, t]));
  const rows = ledgerRows(accountId, state.transactions).filter((r) => {
    const tx = txById.get(r.txId)!;
    if (!r.far) return !isBankSideId(tx.externalId);
    const idx = Number(r.id.split(':')[1]);
    return !isBankSideId(tx.lines[idx]?.farExternalId);
  });
  const { pairs } = matchTransactions(
    pending.map((c) => ({ id: c.externalId, date: c.date, amount: c.amount, name: c.descriptor })),
    rows.map((r) => ({ id: r.id, date: r.date, amount: r.amount, name: payeeName(r.payeeId) || r.memo })),
  );
  const byExternal = new Map(pending.map((c) => [c.externalId, c]));
  const edits: PlanEdit[] = [];
  const matched: ImportPlan['matched'] = [];
  const matchedIds = new Set<string>();
  for (const p of pairs) {
    const c = byExternal.get(p.incomingId)!;
    const [txId, idxText] = p.existingId.split(':');
    const tx = txById.get(txId!)!;
    matchedIds.add(c.externalId);
    if (idxText === undefined) {
      matched.push({ candidate: c, txId: tx.id, side: 'own' });
      edits.push({ table: 'transactions', id: tx.id, patch: { externalId: c.externalId, cleared: 'cleared' } });
    } else {
      const lineIndex = Number(idxText);
      const lines = tx.lines.map((l, i) => (i === lineIndex ? { ...l, farExternalId: c.externalId, farCleared: 'cleared' as const } : l));
      matched.push({ candidate: c, txId: tx.id, side: 'far', lineIndex });
      edits.push({ table: 'transactions', id: tx.id, patch: { lines } });
    }
  }

  const resolver = new PayeeResolver(state.payees, ids);
  const created = pending.filter((c) => !matchedIds.has(c.externalId));
  const txEdits: PlanEdit[] = created.map((c) => {
    const payeeId = resolver.resolve(c.descriptor);
    return {
      table: 'transactions', id: ids(), create: {
        accountId, date: c.date, memo: c.memo, amount: c.amount, cleared: 'cleared',
        // A tracking account's rows need no category, so they are complete on arrival.
        status: account.onBudget ? 'new' : 'ok',
        externalId: c.externalId, source: c.source, lines: [{ amount: c.amount, memo: '' }],
        ...(payeeId ? { payeeId } : {}),
      },
    };
  });
  edits.push(...resolver.createEdits(), ...txEdits);

  const summary = `${candidates.length} in file: ${skipped.length} already imported, ${matched.length} matched, ${created.length} new`;
  return { accountId, skipped, matched, created, payeesToCreate: resolver.created.map(({ id, name }) => ({ id, name })), edits, summary };
}
