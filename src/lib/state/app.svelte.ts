/**
 * The single state layer: a runes mirror of AppState. Every mutation persists
 * through the Repo first, then patches the mirror in place. Screens import
 * `app` and never touch the Repo or Dexie.
 */
import { seedData } from '../domain/seed';
import type { YnabImport } from '../domain/ynab';
import { monthKeyOf } from '../domain/month';
import type { Cents, MonthKey, Row } from '../domain/types';
import { assignmentId, DEFAULT_SETTINGS } from '../domain/types';
import { openDb } from '../storage/db';
import { Repo, type AppState, type Snapshot, type TableName } from '../storage/repo';
import { undoStack } from './undo.svelte';

/** localStorage key; '1' seeds an empty database at boot (e2e uses it). */
export const SEED_FLAG = 'magpie:seed';

const TABLES: TableName[] = ['accounts', 'groups', 'categories', 'assignments', 'transactions', 'payees', 'claims', 'profiles', 'history'];

/** Shape of the JSON backup file. */
export type JsonBackup = Snapshot & { schema: 1; exportedAt: string };

export class AppStore {
  state: AppState = $state({
    accounts: [], groups: [], categories: [], assignments: [], transactions: [], history: [],
    settings: { ...DEFAULT_SETTINGS }, settingsUpdatedAt: 0,
  });
  ready = $state(false);
  /** navigator.storage.persist() outcome, surfaced in Settings. */
  persistentStorage = $state<'granted' | 'denied' | 'unsupported' | 'unknown'>('unknown');
  currentMonth: MonthKey = monthKeyOf(new Date());
  dbName = 'magpie';
  private repo!: Repo;

  /** Hydrate from the database. `seed: false` after a delete-all so the e2e seed flag cannot refill it. */
  async init(dbName = 'magpie', { seed = true } = {}): Promise<void> {
    this.dbName = dbName;
    this.repo = new Repo(openDb(dbName));
    this.currentMonth = monthKeyOf(new Date());
    if (seed && typeof localStorage !== 'undefined' && localStorage.getItem(SEED_FLAG) === '1' && await this.repo.isEmpty()) {
      await this.repo.importRows(seedData(this.currentMonth));
    }
    await this.hydrate();
    void this.requestPersistence();
    this.ready = true;
  }

  private async hydrate(): Promise<void> {
    Object.assign(this.state, await this.repo.loadState());
  }

  private async requestPersistence(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) { this.persistentStorage = 'unsupported'; return; }
    try { this.persistentStorage = (await navigator.storage.persist()) ? 'granted' : 'denied'; }
    catch { this.persistentStorage = 'unknown'; }
  }

  async loadSeed(): Promise<void> {
    await this.repo.importRows(seedData(this.currentMonth));
    await this.hydrate();
    undoStack.clear();
  }

  private async assertEmpty(): Promise<void> {
    if (!(await this.repo.isEmpty())) throw new Error('The database is not empty. Delete all data in Settings first.');
  }

  /** One-time cutover from YNAB (spec §5.1). Only into an empty database. */
  async importYnab(build: YnabImport): Promise<void> {
    await this.assertEmpty();
    const { accounts, groups, categories, payees, transactions, assignments, history } = build;
    await this.repo.importRows({ accounts, groups, categories, payees, transactions, assignments, history });
    await this.repo.updateSettings({ cutoverMonth: build.cutoverMonth });
    await this.hydrate();
    undoStack.clear();
  }

  /** The whole database as pretty JSON, tombstones included: the backup until sync exists. */
  async exportJson(): Promise<string> {
    const snapshot = await this.repo.loadSnapshot();
    const out: JsonBackup = { schema: 1, exportedAt: new Date().toISOString(), ...snapshot };
    return JSON.stringify(out, null, 1);
  }

  /** Restore an exportJson file into an empty database. */
  async importJson(text: string): Promise<void> {
    let data: JsonBackup;
    try { data = JSON.parse(text) as JsonBackup; } catch { throw new Error('That file is not JSON.'); }
    if (data.schema !== 1) throw new Error(`Unsupported backup schema ${String(data.schema)}.`);
    await this.assertEmpty();
    const rows: Partial<Record<TableName, Row[]>> = {};
    for (const t of TABLES) if (Array.isArray(data[t])) rows[t] = data[t];
    await this.repo.importRows(rows);
    if (data.settings && Object.keys(data.settings).length) await this.repo.restoreSettings(data.settings, data.settingsUpdatedAt ?? Date.now());
    await this.hydrate();
    undoStack.clear();
  }

  /** Drop everything and come back up empty. Irreversible; the UI arms this behind a second click. */
  async deleteAllData(): Promise<void> {
    this.ready = false;
    await this.repo.deleteDatabase();
    Object.assign(this.state, { accounts: [], groups: [], categories: [], assignments: [], transactions: [], history: [], settings: { ...DEFAULT_SETTINGS }, settingsUpdatedAt: 0 });
    undoStack.clear();
    await this.init(this.dbName, { seed: false });
  }

  private categoryName(id: string): string {
    return this.state.categories.find((c) => c.id === id)?.name ?? id;
  }

  /** Write an assignment without touching the undo stack. */
  private async writeAssigned(categoryId: string, month: MonthKey, amount: Cents): Promise<void> {
    const row = await this.repo.putAssignment(categoryId, month, amount);
    const i = this.state.assignments.findIndex((a) => a.id === row.id);
    if (i === -1) this.state.assignments.push(row);
    else Object.assign(this.state.assignments[i]!, row);
  }

  /**
   * Undo restores the prior amount; a row that did not exist before is
   * tombstoned again rather than written as 0, so "undo creates nothing"
   * holds. Captured before the write (PB §2.5: undo arms before the mutation).
   */
  async setAssigned(categoryId: string, month: MonthKey, amount: Cents): Promise<void> {
    const prior = this.state.assignments.find((a) => a.categoryId === categoryId && a.month === month)?.amount;
    if ((prior ?? 0) === amount) return;
    undoStack.push(`assign ${this.categoryName(categoryId)}`,
      () => this.restoreAssigned(categoryId, month, prior),
      () => this.writeAssigned(categoryId, month, amount));
    await this.writeAssigned(categoryId, month, amount);
  }

  private async restoreAssigned(categoryId: string, month: MonthKey, prior: Cents | undefined): Promise<void> {
    if (prior !== undefined) { await this.writeAssigned(categoryId, month, prior); return; }
    const id = assignmentId(categoryId, month);
    await this.repo.remove('assignments', id);
    const i = this.state.assignments.findIndex((a) => a.id === id);
    if (i !== -1) this.state.assignments.splice(i, 1);
  }
}

export const app = new AppStore();
