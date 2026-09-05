/**
 * Persistence gateway: the only code that touches IndexedDB.
 *
 * Invariants the sync layer will depend on (PB §2.3, §2.4):
 * - every create stamps id/updatedAt/editedAt; every write restamps with nextStamp
 * - deletes are tombstones, never physical removals
 * - loadState() returns living rows only
 * - a patch is one read-modify-write inside one rw transaction
 */
import { nanoid } from 'nanoid';
import type { Table } from 'dexie';
import {
  assignmentId, DEFAULT_SETTINGS,
  type Account, type Assignment, type Category, type CategoryGroup, type Cents, type CsvProfile, type MonthKey,
  type Payee, type Row, type Settings, type ShareClaim, type Transaction, type YnabHistory,
} from '../domain/types';
import type { MagpieDb } from './db';
import { canonical, supersedes } from '../sync/merge';
import { ROW_TABLES } from '../sync/files';

export type TableName =
  | 'accounts' | 'groups' | 'categories' | 'assignments' | 'transactions'
  | 'payees' | 'claims' | 'profiles' | 'history';

export interface AppState {
  accounts: Account[];
  groups: CategoryGroup[];
  categories: Category[];
  assignments: Assignment[];
  transactions: Transaction[];
  payees: Payee[];
  claims: ShareClaim[];
  profiles: CsvProfile[];
  history: YnabHistory[];
  settings: Settings;
  /** Merge key for the settings singleton; 0 = never written. */
  settingsUpdatedAt: number;
}

export interface Snapshot {
  accounts: Account[];
  groups: CategoryGroup[];
  categories: Category[];
  assignments: Assignment[];
  transactions: Transaction[];
  payees: Payee[];
  claims: ShareClaim[];
  profiles: CsvProfile[];
  history: YnabHistory[];
  settings: Partial<Settings>;
  settingsUpdatedAt: number;
}

/**
 * Now, or one tick past what the row already claims. updatedAt is the merge
 * key; a write that lowers it loses to the copy it meant to replace, so a
 * change must always supersede what it changed, even a future-stamped row.
 */
export function nextStamp(current: number): number {
  return Math.max(Date.now(), current + 1);
}

export function stampNew(): { id: string; updatedAt: number; editedAt: number; deleted: false } {
  const now = Date.now();
  return { id: nanoid(), updatedAt: now, editedAt: now, deleted: false };
}

type Stamped<T> = { data: T; updatedAt: number };

export class Repo {
  constructor(private db: MagpieDb) {}

  private table<T extends Row>(name: TableName): Table<T, string> {
    return this.db[name] as unknown as Table<T, string>;
  }

  async loadState(): Promise<AppState> {
    const [accounts, groups, categories, assignments, transactions, payees, claims, profiles, history, settingsRow] = await Promise.all([
      this.db.accounts.toArray(), this.db.groups.toArray(), this.db.categories.toArray(),
      this.db.assignments.toArray(), this.db.transactions.toArray(), this.db.payees.toArray(),
      this.db.claims.toArray(), this.db.profiles.toArray(), this.db.history.toArray(),
      this.db.kv.get('settings'),
    ]);
    const live = <T extends Row>(rows: T[]) => rows.filter((r) => !r.deleted);
    const s = (settingsRow?.value ?? { data: {}, updatedAt: 0 }) as Stamped<Partial<Settings>>;
    return {
      accounts: live(accounts), groups: live(groups), categories: live(categories),
      assignments: live(assignments), transactions: live(transactions), payees: live(payees),
      claims: live(claims), profiles: live(profiles), history: live(history),
      settings: { ...DEFAULT_SETTINGS, ...s.data },
      settingsUpdatedAt: s.updatedAt,
    };
  }

  async isEmpty(): Promise<boolean> {
    const counts = await Promise.all([this.db.accounts.count(), this.db.categories.count(), this.db.transactions.count()]);
    return counts.every((c) => c === 0);
  }

  /** A draft may bring its own id (deterministic rows do). */
  async create<T extends Row>(table: TableName, draft: Omit<T, keyof Row> & { id?: string }): Promise<T> {
    const row = { ...stampNew(), ...draft } as unknown as T;
    await this.table<T>(table).put(row);
    return row;
  }

  /**
   * Read-modify-put inside one rw transaction: a sync write-back can commit a
   * newer merged row in the gap, and a patch built on a stale read would
   * erase that merge with a stamp high enough to propagate the erasure.
   * put() rather than update() so optional keys can be cleared reliably.
   */
  async patch<T extends Row>(table: TableName, id: string, patch: Partial<T>): Promise<T | undefined> {
    const t = this.table<T>(table);
    return this.db.transaction('rw', t, async () => {
      const row = await t.get(id);
      if (!row) return undefined;
      const next = { ...row, ...patch, updatedAt: nextStamp(row.updatedAt), editedAt: Date.now() } as T;
      await t.put(next);
      return next;
    });
  }

  async remove(table: TableName, id: string): Promise<void> {
    await this.patch(table, id, { deleted: true } as Partial<Row>);
  }

  /** Upsert by deterministic id so two devices assigning the same month collapse into one row. */
  async putAssignment(categoryId: string, month: MonthKey, amount: Cents): Promise<Assignment> {
    const id = assignmentId(categoryId, month);
    return this.db.transaction('rw', this.db.assignments, async () => {
      const prior = await this.db.assignments.get(id);
      const row: Assignment = {
        id, categoryId, month, amount,
        updatedAt: nextStamp(prior?.updatedAt ?? 0), editedAt: Date.now(), deleted: false,
      };
      await this.db.assignments.put(row);
      return row;
    });
  }

  async getSettings(): Promise<Settings> {
    const row = await this.db.kv.get('settings');
    const s = (row?.value ?? { data: {} }) as Stamped<Partial<Settings>>;
    return { ...DEFAULT_SETTINGS, ...s.data };
  }

  /** Sparse on purpose: only explicit choices are stored; defaults apply on read (PB §2.3). */
  async updateSettings(patch: Partial<Settings>): Promise<number> {
    return this.db.transaction('rw', this.db.kv, async () => {
      const row = await this.db.kv.get('settings');
      const prior = (row?.value ?? { data: {}, updatedAt: 0 }) as Stamped<Partial<Settings>>;
      const updatedAt = nextStamp(prior.updatedAt);
      await this.db.kv.put({ key: 'settings', value: { data: { ...prior.data, ...patch }, updatedAt } });
      return updatedAt;
    });
  }

  /** Every row of every table, tombstones included, plus sparse settings: the JSON export and, later, sync. */
  async loadSnapshot(): Promise<Snapshot> {
    const [accounts, groups, categories, assignments, transactions, payees, claims, profiles, history, settingsRow] = await Promise.all([
      this.db.accounts.toArray(), this.db.groups.toArray(), this.db.categories.toArray(), this.db.assignments.toArray(),
      this.db.transactions.toArray(), this.db.payees.toArray(), this.db.claims.toArray(), this.db.profiles.toArray(),
      this.db.history.toArray(), this.db.kv.get('settings'),
    ]);
    const s = (settingsRow?.value ?? { data: {}, updatedAt: 0 }) as Stamped<Partial<Settings>>;
    return { accounts, groups, categories, assignments, transactions, payees, claims, profiles, history, settings: s.data, settingsUpdatedAt: s.updatedAt };
  }

  /** Write settings and their stamp exactly as given: a backup restore keeps the merge key it had. */
  async restoreSettings(data: Partial<Settings>, updatedAt: number): Promise<void> {
    await this.db.kv.put({ key: 'settings', value: { data: { ...data }, updatedAt } });
  }

  /**
   * Write-back after a sync merge (PB §2.6). Not a swap: the merge ran against
   * a snapshot read seconds earlier, so every incoming row is re-checked with
   * the merge rule against what is on disk NOW, inside one transaction. A
   * user edit made during the cycle survives; a tombstone is overruled only by
   * a genuinely newer edit.
   */
  async replaceAll(snap: Snapshot): Promise<void> {
    const tables = ROW_TABLES.map((t) => this.table(t));
    await this.db.transaction('rw', [...tables, this.db.kv], async () => {
      for (const t of ROW_TABLES) {
        const table = this.table(t);
        const mine = new Map((await table.toArray()).map((r) => [r.id, r]));
        const writes = (snap[t] as Row[]).filter((r) => { const m = mine.get(r.id); return !m || supersedes(r, m); });
        if (writes.length) await table.bulkPut(writes);
      }
      const row = await this.db.kv.get('settings');
      const prior = (row?.value ?? { data: {}, updatedAt: 0 }) as Stamped<Partial<Settings>>;
      const newer = snap.settingsUpdatedAt > prior.updatedAt
        || (snap.settingsUpdatedAt === prior.updatedAt && canonical(snap.settings) < canonical(prior.data));
      if (newer) await this.db.kv.put({ key: 'settings', value: { data: { ...snap.settings }, updatedAt: snap.settingsUpdatedAt } });
    });
  }

  /** Device-local values (the sync token, the file cache): never in a snapshot, never in a backup. */
  async getDevice<T>(key: string): Promise<T | undefined> {
    return (await this.db.device.get(key))?.value as T | undefined;
  }

  async setDevice(key: string, value: unknown): Promise<void> {
    if (value === undefined) await this.db.device.delete(key);
    else await this.db.device.put({ key, value });
  }

  /** Drop the whole database. The caller must open a fresh one afterwards. */
  async deleteDatabase(): Promise<void> {
    await this.db.delete();
  }

  /** Bulk write of already-stamped rows across tables, all or nothing. */
  async importRows(rows: Partial<Record<TableName, Row[]>>): Promise<void> {
    const names = Object.keys(rows) as TableName[];
    const tables = names.map((n) => this.table(n));
    await this.db.transaction('rw', tables, async () => {
      for (const n of names) await this.table(n).bulkPut(rows[n]!);
    });
  }
}
