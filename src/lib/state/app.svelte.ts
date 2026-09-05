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
import { emptyDraft, fieldsFromDraft, type LineTarget, type TxDraft } from '../domain/transactions';
import { dueInterest } from '../domain/loans';
import { accountBalances } from '../domain/ledger';
import { todayKey } from '../domain/month';
import { sharedLines } from '../domain/shares';
import { nanoid } from 'nanoid';
import { monthKeyOf } from '../domain/month';
import type { Account, AccountKind, Category, CategoryGroup, Cents, ClearedState, CsvProfile, LoanTerms, MonthKey, Payee, Row, Settings, ShareClaim, Transaction } from '../domain/types';
import { assignmentId, DEFAULT_SETTINGS } from '../domain/types';
import { openDb } from '../storage/db';
import { Repo, type AppState, type BatchOp, type Snapshot, type TableName } from '../storage/repo';
import { undoStack } from './undo.svelte';
import { SyncEngine, type ClientLike, type FileCache, type SyncStatus } from '../sync/engine';
import { GithubClient, type SyncConfig } from '../sync/githubClient';

/** What connectSync needs from a client; the default is the real GithubClient, tests inject a fake. */
export type SyncClient = ClientLike & { checkAuth(): Promise<{ ok: boolean; error?: string }> };

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
  /**
   * Plain-object snapshots per table. Derived views read these instead of
   * snapshotting the whole state: a snapshot of thousands of proxied rows
   * costs real time (PB §2.13), and per-table deriveds only redo the table
   * that changed.
   */
  accountsSnap = $derived($state.snapshot(this.state.accounts));
  groupsSnap = $derived($state.snapshot(this.state.groups));
  categoriesSnap = $derived($state.snapshot(this.state.categories));
  assignmentsSnap = $derived($state.snapshot(this.state.assignments));
  transactionsSnap = $derived($state.snapshot(this.state.transactions));
  payeesSnap = $derived($state.snapshot(this.state.payees));
  claimsSnap = $derived($state.snapshot(this.state.claims));
  historySnap = $derived($state.snapshot(this.state.history));
  /** navigator.storage.persist() outcome, surfaced in Settings. */
  persistentStorage = $state<'granted' | 'denied' | 'unsupported' | 'unknown'>('unknown');
  /** A newer build is installed and waits for a reload (set by the service worker registration). */
  updateReady = $state(false);
  currentMonth: MonthKey = monthKeyOf(new Date());
  dbName = 'magpie';
  private repo!: Repo;

  // ── sync (spec §7) ──────────────────────────────────────────────────────
  syncStatus = $state<SyncStatus>('disabled');
  syncDetail = $state('');
  lastSyncAt = $state<number | null>(null);
  /** Owner and repo for display; the token stays in the device table. */
  syncTarget = $state<{ owner: string; repo: string } | null>(null);
  /** Test seam: replaces the real GitHub client. */
  clientFactory: (cfg: SyncConfig) => SyncClient = (cfg) => new GithubClient(cfg);
  /** Test seam: the debounce after a write. */
  syncDebounceMs = 4000;
  private engine: SyncEngine | null = null;

  private startEngine(cfg: SyncConfig): void {
    this.engine?.dispose();
    // The engine holds the repo it was started with: after delete-all the store opens a new
    // database, and a cycle still in flight must not be able to reach it.
    const repo = this.repo;
    const engine = new SyncEngine({
      client: this.clientFactory(cfg),
      loadLocal: () => repo.loadSnapshot(),
      saveLocal: async (snap) => { await repo.replaceAll(snap); if (this.repo === repo) await this.hydrate(); },
      loadCache: async () => (await repo.getDevice<FileCache>('fileCache')) ?? null,
      saveCache: (cache) => repo.setDevice('fileCache', cache),
      debounceMs: this.syncDebounceMs,
    });
    engine.onStatus = (status, detail) => {
      this.syncStatus = status;
      this.syncDetail = detail;
      if (status === 'idle') this.lastSyncAt = Date.now();
    };
    this.engine = engine;
    this.syncTarget = { owner: cfg.owner, repo: cfg.repo };
    this.syncStatus = 'idle';
  }

  /** Verify the token, remember the config on this device only, and run a first cycle. */
  async connectSync(cfg: SyncConfig): Promise<void> {
    const check = await this.clientFactory(cfg).checkAuth();
    if (!check.ok) throw new Error(check.error ?? 'GitHub rejected the connection.');
    await this.repo.setDevice('syncConfig', cfg);
    this.startEngine(cfg);
    await this.engine!.syncNow();
  }

  async disconnectSync(): Promise<void> {
    this.engine?.dispose();
    this.engine = null;
    await this.repo.setDevice('syncConfig', undefined);
    await this.repo.setDevice('fileCache', undefined);
    this.syncTarget = null;
    this.syncStatus = 'disabled';
    this.syncDetail = '';
  }

  syncNow(): Promise<void> {
    return this.engine?.syncNow() ?? Promise.resolve();
  }

  /** Called at the end of every write path; the engine debounces. */
  private touched(): void {
    this.engine?.requestSync();
  }

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
    const cfg = await this.repo.getDevice<SyncConfig>('syncConfig');
    if (cfg) this.startEngine(cfg);
    this.ready = true;
    void this.syncThenSweep();
  }

  /** Pull first so the sweep sees rows another device posted; sweep regardless if the pull fails or there is no engine. */
  async syncThenSweep(): Promise<void> {
    try { await this.syncNow(); } catch { /* the engine reports its own status */ }
    await this.runInterestSweep();
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
    this.touched();
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
    this.touched();
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
    this.touched();
  }

  /** Drop everything and come back up empty. Irreversible; the UI arms this behind a second click. */
  async deleteAllData(): Promise<void> {
    this.ready = false;
    this.engine?.dispose();
    this.engine = null;
    this.syncTarget = null;
    this.syncStatus = 'disabled';
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
    this.touched();
  }

  /**
   * Several assignment edits as one undo entry. Undo restores each prior
   * amount; a row that did not exist before is tombstoned again rather than
   * written as 0, so "undo creates nothing" holds. Priors are captured before
   * the first write (PB §2.5: undo arms before the mutation).
   */
  async applyAssignments(patches: AssignmentPatch[], label: string): Promise<void> {
    // Months before the cutover show YNAB's own numbers (spec §4.1); a write there would
    // change nothing on screen while quietly feeding goal suggestions.
    const cutover = this.state.settings.cutoverMonth;
    if (cutover && patches.some((p) => p.month < cutover)) throw new Error('Months before the cutover show YNAB history and cannot be edited.');
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
    this.touched();
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
    // One transaction and one mirror pass per direction: a statement import is
    // dozens of edits, and a mirror mutation per row would make every derived
    // view recompute dozens of times.
    const run = (ops: BatchOp[]) => this.writeBatch(ops);
    const apply = (first: boolean) => run(steps.map((s) => ('create' in s
      ? (first ? { table: s.table, id: s.id, create: s.create } : { table: s.table, id: s.id, patch: { deleted: false } })
      : { table: s.table, id: s.id, patch: s.patch })));
    const revert = () => run([...steps].reverse().map((s) => ('create' in s
      ? { table: s.table, id: s.id, patch: { deleted: true } }
      : { table: s.table, id: s.id, patch: s.prior! })));
    undoStack.push(label, revert, () => apply(false));
    await apply(true);
  }

  private async writeBatch(ops: BatchOp[]): Promise<void> {
    const written = await this.repo.applyBatch(ops);
    for (const w of written) this.applyToMirror(w.table, w.row);
    this.touched();
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
  private resolveDraft(draft: TxDraft, payeeName: string | undefined, shared?: { accountId: string; percent: number } | null, existing?: Transaction) {
    const payee = payeeName === undefined ? { id: draft.payeeId, edits: [] as Edit[] } : this.ensurePayee(payeeName);
    const accountsById = this.accountsById();
    let fields: ReturnType<typeof fieldsFromDraft> & { shared?: Transaction['shared'] } =
      fieldsFromDraft({ ...draft, ...(payee.id ? { payeeId: payee.id } : { payeeId: undefined }) }, accountsById);
    if (shared) {
      const categoryId = fields.lines.find((l) => !l.transferAccountId)?.categoryId;
      // A split that came from a sheet claim remembers the total both people paid; a share
      // set by hand covers the whole amount.
      const total = existing?.shared?.total ?? -fields.amount;
      const lines = sharedLines(fields.amount, total, shared.percent, categoryId, shared.accountId);
      const own = accountsById.get(fields.accountId)!;
      const missing = lines.some((l) => !l.categoryId && needsCategory(l, own, l.transferAccountId ? accountsById.get(l.transferAccountId) : undefined));
      fields = { ...fields, lines, status: missing ? 'new' : 'ok', shared: { ...shared, total } };
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

  /** `shared` undefined keeps the stored share and the draft's lines as edited; an object re-derives the split; null clears it. */
  async updateTransaction(id: string, draft: TxDraft, payeeName?: string, shared?: { accountId: string; percent: number } | null): Promise<void> {
    const { fields, edits } = this.resolveDraft(draft, payeeName, shared, this.transaction(id));
    edits.push({ table: 'transactions', id, patch: fields as Partial<Row> });
    await this.commitEdits(edits, 'edit transaction');
  }

  addAccount(name: string, kind: AccountKind, onBudget: boolean): Promise<Account> {
    const sortOrder = Math.max(-1, ...this.state.accounts.map((a) => a.sortOrder)) + 1;
    return this.createRow<Account>('accounts', { name: name.trim(), kind, onBudget: kind === 'person' ? true : onBudget, closed: false, sortOrder, note: '' }, `add account ${name.trim()}`);
  }

  /** Split one bank row by an open claim and close the claim; one undo entry. */
  async applyClaim(claimId: string, txId: string, personAccountId: string): Promise<void> {
    const claim = this.state.claims.find((c) => c.id === claimId);
    const tx = this.transaction(txId);
    if (!claim) throw new Error(`no claim ${claimId}`);
    if (claim.status !== 'open') throw new Error('That claim is no longer open.');
    if (tx.shared || this.state.claims.some((c) => c.transactionId === tx.id && c.status === 'applied')) throw new Error('That transaction is already shared.');
    const categoryId = tx.lines.find((l) => !l.transferAccountId)?.categoryId;
    const lines = sharedLines(tx.amount, claim.total, claim.percent, categoryId, personAccountId);
    await this.commitEdits([
      { table: 'transactions', id: tx.id, patch: { lines, shared: { accountId: personAccountId, percent: claim.percent, total: claim.total }, status: categoryId ? 'ok' : 'new' } as Partial<Row> },
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
    return { transactions: this.transactionsSnap, payees: this.payeesSnap, claims: this.claimsSnap, accountsById: this.accountsById() };
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
    this.touched();
    return row;
  }

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    const updatedAt = await this.repo.updateSettings(patch);
    Object.assign(this.state.settings, patch);
    this.state.settingsUpdatedAt = updatedAt;
    this.touched();
  }

  // ── loans and tracking balances (spec §4.8) ─────────────────────────────

  async setLoanTerms(accountId: string, loan: LoanTerms): Promise<void> {
    const name = this.state.accounts.find((a) => a.id === accountId)?.name ?? 'loan';
    await this.patchRow<Account>('accounts', accountId, { loan }, `loan terms ${name}`);
    await this.runInterestSweep();
  }

  /**
   * Post the interest rows loans without statements are owed up to today. A
   * sweep, not a user action: no undo entry, and idempotent by row id so two
   * devices or two triggers agree.
   */
  async runInterestSweep(today: string = todayKey()): Promise<number> {
    if (!this.repo) return 0;
    const ops: BatchOp[] = [];
    let payeeId: string | undefined;
    for (const a of this.state.accounts) {
      if (a.kind !== 'loan' || !a.loan?.generateInterest || a.closed) continue;
      const candidates = dueInterest($state.snapshot(a), this.transactionsSnap, today);
      if (!candidates.length) continue;
      // The mirror holds living rows only; a month whose row was deleted is still posted.
      const onDisk = await this.repo.existingIds('transactions', candidates.map((d) => d.id));
      const due = candidates.filter((d) => !onDisk.has(d.id));
      if (!due.length) continue;
      if (!payeeId) {
        const p = this.ensurePayee('Interest');
        payeeId = p.id;
        ops.push(...p.edits.map((e) => ('create' in e ? { table: e.table, id: e.id, create: e.create } : { table: e.table, id: e.id, patch: e.patch })));
      }
      for (const d of due) {
        ops.push({ table: 'transactions', id: d.id, create: {
          accountId: a.id, date: d.date, memo: 'Interest', amount: d.amount, cleared: 'cleared', status: 'ok',
          source: { kind: 'manual', batchId: 'interest' }, lines: [{ amount: d.amount, memo: '' }], payeeId,
        } as Omit<Transaction, keyof Row> });
      }
    }
    if (ops.length) await this.writeBatch(ops);
    return ops.filter((o) => o.table === 'transactions').length;
  }

  /** Make a tracking account show `target` by writing one adjustment for the difference; remembers the payee and category. */
  async setBalance(accountId: string, target: Cents, payeeName: string, categoryId?: string): Promise<Transaction | null> {
    const working = accountBalances(this.accountsSnap, this.transactionsSnap).get(accountId)?.working ?? 0;
    const delta = target - working;
    await this.updateSettings({ adjustment: { payeeName, ...(categoryId ? { categoryId } : {}) } });
    if (!delta) return null;
    const draft: TxDraft = {
      ...emptyDraft(accountId, todayKey()), cleared: 'cleared',
      inflow: delta > 0 ? delta : 0, outflow: delta < 0 ? -delta : 0,
      target: categoryId ? { type: 'category', categoryId } : { type: 'none' },
    };
    return this.addTransaction(draft, payeeName);
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
    const { patches, total } = fillPatches(this.state.categories, this.state.groups, this.assignedOf(month), month);
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
    // writePatch tombstones, drops the row from the mirror and requests a sync in one go.
    await this.writePatch('assignments', assignmentId(categoryId, month), { deleted: true });
  }
}

export const app = new AppStore();
