/**
 * The single state layer: a runes mirror of AppState. Every mutation persists
 * through the Repo first, then patches the mirror in place. Screens import
 * `app` and never touch the Repo or Dexie.
 */
import { seedData } from '../domain/seed';
import { monthKeyOf } from '../domain/month';
import type { Cents, MonthKey } from '../domain/types';
import { assignmentId, DEFAULT_SETTINGS } from '../domain/types';
import { openDb } from '../storage/db';
import { Repo, type AppState } from '../storage/repo';
import { undoStack } from './undo.svelte';

/** localStorage key; '1' seeds an empty database at boot (e2e uses it). */
export const SEED_FLAG = 'magpie:seed';

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

  async init(dbName = 'magpie'): Promise<void> {
    this.dbName = dbName;
    this.repo = new Repo(openDb(dbName));
    this.currentMonth = monthKeyOf(new Date());
    if (typeof localStorage !== 'undefined' && localStorage.getItem(SEED_FLAG) === '1' && await this.repo.isEmpty()) {
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
