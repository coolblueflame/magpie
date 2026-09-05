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
import { normalisePayeeKey } from '../domain/payees';
import { needsCategory } from '../domain/ledger';
import { fieldsFromDraft, type LineTarget, type TxDraft } from '../domain/transactions';
import { sharedLines } from '../domain/shares';
import { nanoid } from 'nanoid';
import { monthKeyOf } from '../domain/month';
import type { Account, AccountKind, Category, CategoryGroup, Cents, ClearedState, CsvProfile, MonthKey, Payee, Row, Settings, ShareClaim, Transaction } from '../domain/types';
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
    accounts: [], groups: [], categories: [], assignments: [], transactions: [], payees: [], claims: [], profiles: [], history: [],
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
    Object.assign(this.state, { accounts: [], groups: [], categories: [], assignments: [], transactions: [], payees: [], claims: [], profiles: [], history: [], settings: { ...DEFAULT_SETTINGS }, settingsUpdatedAt: 0 });
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
      case 'claims': return this.state.claims;
      case 'profiles': return this.state.profiles;
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

  // ── transactions and payees (phase 3b) ──────────────────────────────────

  private accountsById(): Map<string, Account> {
    return new Map(this.state.accounts.map((a) => [a.id, a]));
  }

  private transaction(id: string): Transaction {
    const t = this.state.transactions.find((x) => x.id === id);
    if (!t) throw new Error(`no transaction ${id}`);
    return t;
  }

  /** An existing payee by name or alias, or the edit that creates one. Empty names resolve to no payee. */
  ensurePayee(name: string): { id?: string; edits: Edit[] } {
    const key = normalisePayeeKey(name);
    if (!key) return { edits: [] };
    const existing = this.state.payees.find((p) => normalisePayeeKey(p.name) === key || p.aliases.includes(key));
    if (existing) return { id: existing.id, edits: [] };
    const id = nanoid();
    return { id, edits: [{ table: 'payees', id, create: { name: name.trim(), aliases: [], note: '' } }] };
  }

  /**
   * The stored fields for a draft, with the payee resolved from typed text when
   * given. A `shared` choice re-derives the lines from the draft's category by
   * the §4.4 rule (the whole amount is what the user paid); `null` clears it.
   */
  private resolveDraft(draft: TxDraft, payeeName: string | undefined, shared?: { accountId: string; percent: number } | null) {
    const payee = payeeName === undefined ? { id: draft.payeeId, edits: [] as Edit[] } : this.ensurePayee(payeeName);
    const accountsById = this.accountsById();
    let fields: ReturnType<typeof fieldsFromDraft> & { shared?: Transaction['shared'] } =
      fieldsFromDraft({ ...draft, ...(payee.id ? { payeeId: payee.id } : { payeeId: undefined }) }, accountsById);
    if (shared) {
      const categoryId = fields.lines.find((l) => !l.transferAccountId)?.categoryId;
      const lines = sharedLines(fields.amount, -fields.amount, shared.percent, categoryId, shared.accountId);
      const own = accountsById.get(fields.accountId)!;
      const missing = lines.some((l) => !l.categoryId && needsCategory(l, own, l.transferAccountId ? accountsById.get(l.transferAccountId) : undefined));
      fields = { ...fields, lines, status: missing ? 'new' : 'ok', shared };
    } else if (shared === null) {
      fields = { ...fields, shared: undefined };
    }
    return { fields: { ...fields, payeeId: payee.id }, edits: payee.edits };
  }

  async addTransaction(draft: TxDraft, payeeName?: string, shared?: { accountId: string; percent: number } | null): Promise<Transaction> {
    const { fields, edits } = this.resolveDraft(draft, payeeName, shared);
    const id = nanoid();
    edits.push({ table: 'transactions', id, create: { ...fields, source: { kind: 'manual', batchId: 'manual' } } });
    await this.commitEdits(edits, 'add transaction');
    return this.transaction(id);
  }

  async updateTransaction(id: string, draft: TxDraft, payeeName?: string, shared?: { accountId: string; percent: number } | null): Promise<void> {
    const { fields, edits } = this.resolveDraft(draft, payeeName, shared);
    edits.push({ table: 'transactions', id, patch: fields as Partial<Row> });
    await this.commitEdits(edits, 'edit transaction');
  }

  addAccount(name: string, kind: AccountKind, onBudget: boolean): Promise<Account> {
    const sortOrder = Math.max(-1, ...this.state.accounts.map((a) => a.sortOrder)) + 1;
    return this.createRow<Account>('accounts', { name: name.trim(), kind, onBudget: kind === 'person' ? true : onBudget, closed: false, sortOrder, note: '' }, `add account ${name.trim()}`);
  }

  /** Split one bank row by an open claim and close the claim; one undo entry. */
  applyClaim(claimId: string, txId: string, personAccountId: string): Promise<void> {
    const claim = this.state.claims.find((c) => c.id === claimId);
    const tx = this.transaction(txId);
    if (!claim) throw new Error(`no claim ${claimId}`);
    const categoryId = tx.lines.find((l) => !l.transferAccountId)?.categoryId;
    const lines = sharedLines(tx.amount, claim.total, claim.percent, categoryId, personAccountId);
    return this.commitEdits([
      { table: 'transactions', id: tx.id, patch: { lines, shared: { accountId: personAccountId, percent: claim.percent }, status: categoryId ? 'ok' : 'new' } as Partial<Row> },
      { table: 'claims', id: claim.id, patch: { status: 'applied', transactionId: tx.id } as Partial<Row> },
    ], 'apply shared claim');
  }

  dismissClaim(claimId: string): Promise<void> {
    return this.patchRow<ShareClaim>('claims', claimId, { status: 'dismissed' }, 'dismiss claim');
  }

  deleteTransaction(id: string): Promise<void> {
    return this.patchRow<Transaction>('transactions', id, { deleted: true }, 'delete transaction');
  }

  /** Cleared state for one side of a row: the owning account's, or a transfer's far side. */
  setCleared(txId: string, accountId: string, cleared: ClearedState): Promise<void> {
    const tx = this.transaction(txId);
    const label = cleared === 'cleared' ? 'clear' : 'unclear';
    if (tx.accountId === accountId) return this.patchRow<Transaction>('transactions', txId, { cleared }, label);
    const lines = $state.snapshot(tx.lines).map((l) => (l.transferAccountId === accountId ? { ...l, farCleared: cleared } : l));
    return this.patchRow<Transaction>('transactions', txId, { lines }, label);
  }

  /** The patch that confirms a `new` row with a target for its single line; throws if a budget line would still lack a category. */
  private confirmPatch(tx: Transaction, target: LineTarget | undefined): Partial<Transaction> {
    const draft: TxDraft = {
      accountId: tx.accountId, date: tx.date, memo: tx.memo, cleared: tx.cleared,
      outflow: tx.amount < 0 ? -tx.amount : 0, inflow: tx.amount > 0 ? tx.amount : 0,
      split: tx.lines.length > 1,
      target: target ?? (tx.lines[0]?.categoryId ? { type: 'category', categoryId: tx.lines[0].categoryId } : { type: 'none' }),
      lines: tx.lines.length > 1 ? tx.lines.map((l) => ({ target: l.categoryId ? { type: 'category' as const, categoryId: l.categoryId } : { type: 'none' as const }, amount: l.amount, memo: l.memo })) : [],
      ...(tx.payeeId ? { payeeId: tx.payeeId } : {}),
    };
    const fields = fieldsFromDraft(draft, this.accountsById());
    if (fields.status !== 'ok') throw new Error('Pick a category first.');
    return { lines: fields.lines, status: 'ok' };
  }

  async confirmTransaction(id: string, target?: LineTarget): Promise<void> {
    await this.patchRow<Transaction>('transactions', id, this.confirmPatch(this.transaction(id), target), 'confirm transaction');
  }

  async confirmAll(items: { id: string; target?: LineTarget }[]): Promise<void> {
    await this.patchRows<Transaction>('transactions',
      items.map((i) => ({ id: i.id, patch: this.confirmPatch(this.transaction(i.id), i.target) })),
      `confirm ${items.length} transactions`);
  }

  renamePayee(id: string, name: string): Promise<void> {
    const p = this.state.payees.find((x) => x.id === id);
    return this.patchRow<Payee>('payees', id, { name: name.trim() }, `rename ${p?.name ?? 'payee'}`);
  }

  /** Point every transaction of the merged payees at the survivor, keep their names as aliases, tombstone them. */
  mergePayees(ids: string[], into: string): Promise<void> {
    const others = ids.filter((id) => id !== into);
    const survivor = this.state.payees.find((p) => p.id === into);
    if (!survivor || !others.length) throw new Error('pick at least two payees');
    const gone = this.state.payees.filter((p) => others.includes(p.id));
    const aliases = [...new Set([...survivor.aliases, ...gone.flatMap((p) => [normalisePayeeKey(p.name), ...p.aliases])])];
    const edits: Edit[] = this.state.transactions
      .filter((t) => t.payeeId && others.includes(t.payeeId))
      .map((t) => ({ table: 'transactions', id: t.id, patch: { payeeId: into } as Partial<Row> }));
    edits.push({ table: 'payees', id: into, patch: { aliases } as Partial<Row> });
    for (const p of gone) edits.push({ table: 'payees', id: p.id, patch: { deleted: true } });
    return this.commitEdits(edits, `merge ${ids.length} payees`);
  }

  // ── file import (phase 4) ───────────────────────────────────────────────

  /** Everything the import planners read; a snapshot so the planners see plain rows. */
  importState() {
    return {
      transactions: $state.snapshot(this.state.transactions), payees: $state.snapshot(this.state.payees),
      claims: $state.snapshot(this.state.claims), accountsById: this.accountsById(),
    };
  }

  /** One file's worth of creates and patches as one undo entry. */
  applyEdits(edits: Edit[], label: string): Promise<void> {
    return this.commitEdits(edits, label);
  }

  /** Not undoable on purpose: which bank file belongs to which account is bookkeeping, not a user edit. */
  async rememberAccountRef(accountId: string, externalRef: string): Promise<void> {
    await this.writePatch('accounts', accountId, { externalRef } as Partial<Row>);
  }

  async saveProfile(profile: Omit<CsvProfile, keyof Row> & { id?: string }): Promise<CsvProfile> {
    const existing = profile.id ? this.state.profiles.find((p) => p.id === profile.id) : undefined;
    if (existing) { await this.writePatch('profiles', existing.id, profile as Partial<Row>); return this.state.profiles.find((p) => p.id === existing.id)!; }
    const row = await this.repo.create<CsvProfile>('profiles', profile);
    this.applyToMirror('profiles', row);
    return row;
  }

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    const updatedAt = await this.repo.updateSettings(patch);
    Object.assign(this.state.settings, patch);
    this.state.settingsUpdatedAt = updatedAt;
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
