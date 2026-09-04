/**
 * The single state layer: a runes mirror of AppState. Every mutation persists
 * through the Repo first, then patches the mirror in place. Screens import
 * `app` and never touch the Repo or Dexie.
 */
import { seedData } from '../domain/seed';
import type { YnabImport } from '../domain/ynab';
import { fillPatches, type AssignmentPatch } from '../domain/goals';
import { movePatches, type MoveEnd } from '../domain/moves';
import { formatMoney } from '../domain/money';
import { nanoid } from 'nanoid';
import { monthKeyOf } from '../domain/month';
import type { Category, CategoryGroup, Cents, MonthKey, Row } from '../domain/types';
import { assignmentId, DEFAULT_SETTINGS } from '../domain/types';
import { openDb } from '../storage/db';
import { Repo, type AppState, type Snapshot, type TableName } from '../storage/repo';
import { undoStack } from './undo.svelte';

/** localStorage key; '1' seeds an empty database at boot (e2e uses it). */
export const SEED_FLAG = 'magpie:seed';

const TABLES: TableName[] = ['accounts', 'groups', 'categories', 'assignments', 'transactions', 'payees', 'claims', 'profiles', 'history'];

/** Shape of the JSON backup file. */
export type JsonBackup = Snapshot & { schema: 1; exportedAt: string };

/** One step of an undoable batch: patch an existing row, or create a new one under a pre-minted id. */
export type Edit =
  | { table: TableName; id: string; patch: Partial<Row> }
  | { table: TableName; id: string; create: Omit<Row, keyof Row> };

export class AppStore {
  state: AppState = $state({
    accounts: [], groups: [], categories: [], assignments: [], transactions: [], payees: [], history: [],
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
    Object.assign(this.state, { accounts: [], groups: [], categories: [], assignments: [], transactions: [], payees: [], history: [], settings: { ...DEFAULT_SETTINGS }, settingsUpdatedAt: 0 });
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
   * Several assignment edits as one undo entry. Undo restores each prior
   * amount; a row that did not exist before is tombstoned again rather than
   * written as 0, so "undo creates nothing" holds. Priors are captured before
   * the first write (PB §2.5: undo arms before the mutation).
   */
  async applyAssignments(patches: AssignmentPatch[], label: string): Promise<void> {
    const withPrior = patches.map((p) => ({ ...p, prior: this.assignedOf(p.month)(p.categoryId, true) }));
    const effective = withPrior.filter((p) => (p.prior ?? 0) !== p.amount);
    if (!effective.length) return;
    const apply = async () => { for (const p of effective) await this.writeAssigned(p.categoryId, p.month, p.amount); };
    const revert = async () => { for (const p of effective) await this.restoreAssigned(p.categoryId, p.month, p.prior); };
    undoStack.push(label, revert, apply);
    await apply();
  }

  async setAssigned(categoryId: string, month: MonthKey, amount: Cents): Promise<void> {
    await this.applyAssignments([{ categoryId, month, amount }], `assign ${this.categoryName(categoryId)}`);
  }

  /** The assigned amount for a category in a month; `raw` returns undefined for a missing row. */
  assignedOf(month: MonthKey): (categoryId: string, raw?: boolean) => Cents;
  assignedOf(month: MonthKey) {
    return (categoryId: string, raw = false): Cents | undefined => {
      const amount = this.state.assignments.find((a) => a.categoryId === categoryId && a.month === month)?.amount;
      return raw ? amount : (amount ?? 0);
    };
  }

  // ── generic undoable writes ─────────────────────────────────────────────

  private mirrorOf(table: TableName): Row[] {
    switch (table) {
      case 'accounts': return this.state.accounts;
      case 'groups': return this.state.groups;
      case 'categories': return this.state.categories;
      case 'assignments': return this.state.assignments;
      case 'transactions': return this.state.transactions;
      case 'payees': return this.state.payees;
      case 'history': return this.state.history;
      default: throw new Error(`${table} is not mirrored`);
    }
  }

  /** Reflect a row as written: tombstones leave the mirror, new rows join it, others patch in place. */
  private applyToMirror(table: TableName, row: Row): void {
    const arr = this.mirrorOf(table);
    const i = arr.findIndex((r) => r.id === row.id);
    if (row.deleted) { if (i !== -1) arr.splice(i, 1); }
    else if (i === -1) arr.push(row);
    else Object.assign(arr[i]!, row);
  }

  private async writePatch<T extends Row>(table: TableName, id: string, patch: Partial<T>): Promise<void> {
    const row = await this.repo.patch<T>(table, id, patch);
    if (row) this.applyToMirror(table, row);
  }

  /**
   * Any number of creates and patches across tables as ONE undo entry. Priors
   * are captured from the mirror before the first write; undo runs in reverse
   * order (creates become tombstones, patches restore their prior keys); redo
   * re-applies (a create comes back by clearing its tombstone).
   */
  async commitEdits(edits: Edit[], label: string): Promise<void> {
    const steps = edits.map((e) => {
      if ('create' in e) return { ...e, prior: undefined };
      const current = this.mirrorOf(e.table).find((r) => r.id === e.id);
      if (!current) throw new Error(`no ${e.table} row ${e.id}`);
      const prior = Object.fromEntries(Object.keys(e.patch).map((k) => [k, $state.snapshot((current as unknown as Record<string, unknown>)[k])])) as Partial<Row>;
      return { ...e, prior };
    });
    const apply = async (first: boolean) => {
      for (const s of steps) {
        if ('create' in s) {
          if (first) { const row = await this.repo.create<Row>(s.table, { ...s.create, id: s.id } as Omit<Row, keyof Row> & { id: string }); this.applyToMirror(s.table, row); }
          else await this.writePatch(s.table, s.id, { deleted: false });
        } else await this.writePatch(s.table, s.id, s.patch);
      }
    };
    const revert = async () => {
      for (const s of [...steps].reverse()) {
        if ('create' in s) await this.writePatch(s.table, s.id, { deleted: true });
        else await this.writePatch(s.table, s.id, s.prior!);
      }
    };
    undoStack.push(label, revert, () => apply(false));
    await apply(true);
  }

  /** One undoable patch. Undo restores exactly the keys the patch touched, as they were. */
  patchRow<T extends Row>(table: TableName, id: string, patch: Partial<T>, label: string): Promise<void> {
    return this.commitEdits([{ table, id, patch: patch as Partial<Row> }], label);
  }

  /** Several patches on one table as one undo entry. */
  patchRows<T extends Row>(table: TableName, edits: { id: string; patch: Partial<T> }[], label: string): Promise<void> {
    return this.commitEdits(edits.map((e) => ({ table, id: e.id, patch: e.patch as Partial<Row> })), label);
  }

  /** One undoable create. The id is minted first so undo is armed before the write. */
  async createRow<T extends Row>(table: TableName, draft: Omit<T, keyof Row>, label: string): Promise<T> {
    const id = nanoid();
    await this.commitEdits([{ table, id, create: draft as Omit<Row, keyof Row> }], label);
    return this.mirrorOf(table).find((r) => r.id === id) as T;
  }

  // ── budget management (phase 3a) ────────────────────────────────────────

  private category(id: string): Category {
    const c = this.state.categories.find((x) => x.id === id);
    if (!c) throw new Error(`no category ${id}`);
    return c;
  }

  private group(id: string): CategoryGroup {
    const g = this.state.groups.find((x) => x.id === id);
    if (!g) throw new Error(`no group ${id}`);
    return g;
  }

  setGoal(categoryId: string, goal: Cents): Promise<void> {
    return this.patchRow<Category>('categories', categoryId, { goal }, `goal ${this.categoryName(categoryId)}`);
  }

  /** Adopt suggested goals for several categories at once; one undo entry. */
  setGoals(goals: { categoryId: string; goal: Cents }[]): Promise<void> {
    return this.patchRows<Category>('categories', goals.map((g) => ({ id: g.categoryId, patch: { goal: g.goal } })), 'adopt suggested goals');
  }

  async fillGoal(categoryId: string, month: MonthKey): Promise<void> {
    const c = this.category(categoryId);
    if (c.goal <= this.assignedOf(month)(categoryId)) return;
    await this.applyAssignments([{ categoryId, month, amount: c.goal }], `fill ${c.name}`);
  }

  /** Every visible category up to its goal; returns what it took from Ready to Assign. */
  async fillAllGoals(month: MonthKey): Promise<Cents> {
    const { patches, total } = fillPatches(this.state.categories, this.assignedOf(month), month);
    await this.applyAssignments(patches, 'fill all goals');
    return total;
  }

  moveMoney(from: MoveEnd, to: MoveEnd, month: MonthKey, amount: Cents): Promise<void> {
    return this.applyAssignments(movePatches(from, to, month, amount, this.assignedOf(month)), `move ${formatMoney(amount)}`);
  }

  addCategory(groupId: string, name: string): Promise<Category> {
    const sortOrder = Math.max(-1, ...this.state.categories.filter((c) => c.groupId === groupId).map((c) => c.sortOrder)) + 1;
    return this.createRow<Category>('categories', { groupId, name, goal: 0, sortOrder, hidden: false, note: '' }, `add ${name}`);
  }

  renameCategory(id: string, name: string): Promise<void> {
    return this.patchRow<Category>('categories', id, { name }, `rename ${this.category(id).name}`);
  }

  setCategoryHidden(id: string, hidden: boolean): Promise<void> {
    return this.patchRow<Category>('categories', id, { hidden }, `${hidden ? 'hide' : 'unhide'} ${this.category(id).name}`);
  }

  addGroup(name: string): Promise<CategoryGroup> {
    const sortOrder = Math.max(-1, ...this.state.groups.map((g) => g.sortOrder)) + 1;
    return this.createRow<CategoryGroup>('groups', { name, sortOrder, hidden: false }, `add group ${name}`);
  }

  renameGroup(id: string, name: string): Promise<void> {
    return this.patchRow<CategoryGroup>('groups', id, { name }, `rename ${this.group(id).name}`);
  }

  setGroupHidden(id: string, hidden: boolean): Promise<void> {
    return this.patchRow<CategoryGroup>('groups', id, { hidden }, `${hidden ? 'hide' : 'unhide'} ${this.group(id).name}`);
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
