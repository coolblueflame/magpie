/**
 * Sync file layout (spec §7, PB §2.6). The data repo holds:
 *   meta.json          { schema }                      the version gate
 *   active.json        accounts, groups, categories, payees, claims, profiles, settings
 *   assignments.json   every assignment row
 *   history.json       YNAB history (static after import)
 *   tx-<year>.json     transactions by the year of their date
 *
 * The Contents API replaces a file whole, so an edit rewrites only the file
 * its row lives in. Tombstones older than 90 days are compacted away here.
 */
import type { Snapshot } from '../storage/repo';
import type { Row, Settings, Transaction } from '../domain/types';

/** Bump whenever the layout changes; an older build must fail loudly rather than read a new layout as empty. */
export const SCHEMA_VERSION = 1;
const TOMBSTONE_TTL_MS = 90 * 86_400_000;

/** Thrown when the remote was written by a newer app; never clobber it. */
export class SchemaTooNewError extends Error {
  constructor(found: number) {
    super(`The data repo was written by a newer Magpie (schema ${found}, this build reads ${SCHEMA_VERSION}). Update the app.`);
  }
}

export type SyncFilePayloads = Record<string, unknown>;

/** The row tables in the order files list them; every one of these must appear in toFiles and fromFiles. */
export const ROW_TABLES = ['accounts', 'groups', 'categories', 'assignments', 'transactions', 'payees', 'claims', 'profiles', 'history'] as const;
export type RowTable = (typeof ROW_TABLES)[number];

interface ActiveFile {
  schema: number;
  accounts: Row[]; groups: Row[]; categories: Row[]; payees: Row[]; claims: Row[]; profiles: Row[];
  settings: Partial<Settings>;
  settingsUpdatedAt: number;
}

const gate = (payload: unknown) => {
  const schema = (payload as { schema?: number } | undefined)?.schema;
  if (schema !== undefined && schema > SCHEMA_VERSION) throw new SchemaTooNewError(schema);
};

export function toFiles(snap: Snapshot, now: Date): SyncFilePayloads {
  const keep = <T extends Row>(row: T) => !row.deleted || now.getTime() - row.updatedAt < TOMBSTONE_TTL_MS;
  const active: ActiveFile = {
    schema: SCHEMA_VERSION,
    accounts: snap.accounts.filter(keep), groups: snap.groups.filter(keep), categories: snap.categories.filter(keep),
    payees: snap.payees.filter(keep), claims: snap.claims.filter(keep), profiles: snap.profiles.filter(keep),
    settings: snap.settings, settingsUpdatedAt: snap.settingsUpdatedAt,
  };
  const files: SyncFilePayloads = { 'active.json': active };
  files['assignments.json'] = { schema: SCHEMA_VERSION, assignments: snap.assignments.filter(keep) };
  files['history.json'] = { schema: SCHEMA_VERSION, history: snap.history.filter(keep) };
  const byYear = new Map<string, Transaction[]>();
  for (const t of snap.transactions.filter(keep)) {
    const year = t.date.slice(0, 4);
    const bucket = byYear.get(year) ?? [];
    bucket.push(t);
    byYear.set(year, bucket);
  }
  for (const [year, transactions] of byYear) files[`tx-${year}.json`] = { schema: SCHEMA_VERSION, transactions };
  files['meta.json'] = { schema: SCHEMA_VERSION };
  return files;
}

export function fromFiles(files: SyncFilePayloads): Snapshot {
  gate(files['meta.json']);
  const active = (files['active.json'] as Partial<ActiveFile> | undefined) ?? {};
  gate(active);
  const assignments = (files['assignments.json'] as { schema?: number; assignments?: Row[] } | undefined) ?? {};
  gate(assignments);
  const history = (files['history.json'] as { schema?: number; history?: Row[] } | undefined) ?? {};
  gate(history);
  // A row can sit in two year files mid-migration; the union keeps the newest copy.
  const byId = new Map<string, Transaction>();
  for (const [path, payload] of Object.entries(files)) {
    if (!path.startsWith('tx-')) continue;
    gate(payload);
    for (const row of ((payload as { transactions?: Transaction[] }).transactions ?? [])) {
      const seen = byId.get(row.id);
      if (!seen || row.updatedAt > seen.updatedAt) byId.set(row.id, row);
    }
  }
  return {
    accounts: (active.accounts ?? []) as Snapshot['accounts'],
    groups: (active.groups ?? []) as Snapshot['groups'],
    categories: (active.categories ?? []) as Snapshot['categories'],
    assignments: (assignments.assignments ?? []) as Snapshot['assignments'],
    transactions: [...byId.values()],
    payees: (active.payees ?? []) as Snapshot['payees'],
    claims: (active.claims ?? []) as Snapshot['claims'],
    profiles: (active.profiles ?? []) as Snapshot['profiles'],
    history: (history.history ?? []) as Snapshot['history'],
    settings: active.settings ?? {},
    settingsUpdatedAt: active.settingsUpdatedAt ?? 0,
  };
}
