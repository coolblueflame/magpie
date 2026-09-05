/**
 * Entity-level newest-wins merge (spec §7, PB §2.7). No field merging: per id
 * the row with the larger updatedAt wins wholesale; ties prefer the tombstone,
 * then the later editedAt, then the canonically smaller content so both sides
 * pick the same winner. Rows present on one side only always survive, which is
 * how adds and tombstones propagate. Settings merge by their own stamp.
 */
import type { Snapshot } from '../storage/repo';
import type { Row } from '../domain/types';
import { ROW_TABLES } from './files';

export interface MergeResult {
  merged: Snapshot;
  /** merged differs from local: persist it. */
  localChanged: boolean;
  /** merged differs from remote: push it. */
  remoteChanged: boolean;
}

/** Order-independent serialisation: IndexedDB and JSON disagree on key order, and layout is not content. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([x], [y]) => (x < y ? -1 : 1))
    .map(([k, val]) => `${JSON.stringify(k)}:${canonical(val)}`)
    .join(',')}}`;
}

export function pick<T extends Row>(a: T, b: T): T {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  if (a.deleted !== b.deleted) return a.deleted ? a : b;
  // Clamped stamps collide routinely; the honest clock breaks the tie, and a side that has one beats a side that lacks one.
  const ea = a.editedAt ?? 0, eb = b.editedAt ?? 0;
  if (ea !== eb) return ea > eb ? a : b;
  // Same stamp, same tombstone state, different content: preferring "mine" would leave each device sure it is right forever.
  const [ca, cb] = [canonical(a), canonical(b)];
  return ca <= cb ? a : b;
}

/** Does incoming beat the copy already in storage? The write-back re-applies this at the moment it touches the database. */
export function supersedes(incoming: Row, mine: Row): boolean {
  return pick(mine, incoming) === incoming;
}

function mergeRows<T extends Row>(local: T[], remote: T[]): T[] {
  const byId = new Map<string, T>();
  for (const row of local) byId.set(row.id, row);
  for (const row of remote) {
    const existing = byId.get(row.id);
    byId.set(row.id, existing ? pick(existing, row) : row);
  }
  return [...byId.values()];
}

function sameRows<T extends Row>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  const byId = new Map(a.map((r) => [r.id, r]));
  return b.every((r) => {
    const match = byId.get(r.id);
    return match !== undefined && canonical(match) === canonical(r);
  });
}

function pickSingleton<V>(a: V, aStamp: number, b: V, bStamp: number): [V, number] {
  if (aStamp !== bStamp) return aStamp > bStamp ? [a, aStamp] : [b, bStamp];
  return canonical(a) <= canonical(b) ? [a, aStamp] : [b, bStamp];
}

export function mergeSnapshots(local: Snapshot, remote: Snapshot): MergeResult {
  const [settings, settingsUpdatedAt] = pickSingleton(local.settings, local.settingsUpdatedAt, remote.settings, remote.settingsUpdatedAt);
  const merged = { settings, settingsUpdatedAt } as Snapshot;
  for (const t of ROW_TABLES) (merged as unknown as Record<string, Row[]>)[t] = mergeRows(local[t] as Row[], remote[t] as Row[]);
  const sameAs = (side: Snapshot) =>
    ROW_TABLES.every((t) => sameRows(merged[t] as Row[], side[t] as Row[])) &&
    canonical(merged.settings) === canonical(side.settings) &&
    merged.settingsUpdatedAt === side.settingsUpdatedAt;
  return { merged, localChanged: !sameAs(local), remoteChanged: !sameAs(remote) };
}
