import { beforeEach, describe, expect, test } from 'vitest';
import { AppStore } from './app.svelte';
import { undoStack } from './undo.svelte';
import { seedData } from '../domain/seed';
import { computeBudget } from '../domain/budget';
import { RTA, type Category } from '../domain/types';
import { draftFromTransaction, emptyDraft } from '../domain/transactions';
import type { RemoteFile, RemoteFileEntry } from '../sync/githubClient';
import type { SyncClient } from './app.svelte';

/** The engine test's fake, plus checkAuth. */
class FakeClient implements SyncClient {
  files = new Map<string, { json: unknown; sha: string }>();
  puts: string[] = [];
  private n = 0;
  async checkAuth() { return { ok: true }; }
  async listFiles(): Promise<RemoteFileEntry[]> { return [...this.files].map(([path, f]) => ({ path, sha: f.sha })); }
  async getFile(path: string): Promise<RemoteFile | null> { const f = this.files.get(path); return f ? { json: JSON.parse(JSON.stringify(f.json)), sha: f.sha } : null; }
  async putFile(path: string, json: unknown): Promise<string> { const sha = `s${++this.n}`; this.files.set(path, { json: JSON.parse(JSON.stringify(json)), sha }); this.puts.push(path); return sha; }
}
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
import { buildYnabImport, readYnabPlan, readYnabRegister } from '../domain/ynab';
import { PLAN_CSV, REGISTER_CSV } from '../domain/ynabFixture';

function fixtureBuild() {
  return buildYnabImport(readYnabRegister(REGISTER_CSV), readYnabPlan(PLAN_CSV), {
    accounts: {
      Chequing: { kind: 'chequing', onBudget: true }, Card: { kind: 'credit', onBudget: true },
      Partner: { kind: 'other', onBudget: false, person: true }, Brokerage: { kind: 'investment', onBudget: false },
    },
    now: Date.now(),
  });
}

let n = 0;
async function fresh(): Promise<AppStore> {
  const store = new AppStore();
  await store.init(`app-test-${++n}-${Date.now()}`);
  return store;
}

describe('AppStore', () => {
  beforeEach(() => undoStack.clear());

  test('init on an empty database is ready with nothing', async () => {
    const s = await fresh();
    expect(s.ready).toBe(true);
    expect(s.state.accounts).toEqual([]);
  });

  test('loadSeed populates the mirror', async () => {
    const s = await fresh();
    await s.loadSeed();
    const seed = seedData(s.currentMonth);
    expect(s.state.categories.map((c) => c.id).sort()).toEqual(seed.categories.map((c) => c.id).sort());
    expect(s.state.transactions).toHaveLength(seed.transactions.length);
  });

  test('setAssigned persists, patches the mirror, and undoes', async () => {
    const s = await fresh();
    await s.loadSeed();
    const m = s.currentMonth;
    await s.setAssigned('cat_groc', m, 70000);
    const find = () => s.state.assignments.find((a) => a.categoryId === 'cat_groc' && a.month === m);
    expect(find()!.amount).toBe(70000);
    const reloaded = new AppStore();
    await reloaded.init(s.dbName);
    expect(reloaded.state.assignments.find((a) => a.categoryId === 'cat_groc' && a.month === m)!.amount).toBe(70000);
    expect(await undoStack.undo()).toBe('assign Groceries');
    expect(find()!.amount).toBe(60000);
    expect(await undoStack.redo()).toBe('assign Groceries');
    expect(find()!.amount).toBe(70000);
  });

  test('importYnab fills an empty store and sets the cutover month; a second import is refused', async () => {
    const s = await fresh();
    await s.importYnab(fixtureBuild());
    expect(s.state.categories).toHaveLength(4);
    expect(s.state.transactions).toHaveLength(12);
    expect(s.state.settings.cutoverMonth).toBe('2026-09');
    await expect(s.importYnab(fixtureBuild())).rejects.toThrow(/not empty/);
  });

  test('exportJson and importJson round-trip everything, tombstones included', async () => {
    const s = await fresh();
    await s.importYnab(fixtureBuild());
    await s.setAssigned('x', '2026-10', 1);            // an extra assignment row
    await undoStack.undo();                             // now a tombstone on disk
    const text = await s.exportJson();
    const t = await fresh();
    await t.importJson(text);
    const strip = (j: string) => { const o = JSON.parse(j); delete o.exportedAt; return o; };
    expect(strip(await t.exportJson())).toEqual(strip(text));
    expect(t.state.settings.cutoverMonth).toBe('2026-09');
    expect(JSON.parse(text).assignments.some((a: { deleted: boolean }) => a.deleted)).toBe(true);
    await expect(t.importJson(text)).rejects.toThrow(/not empty/);
    await expect((await fresh()).importJson('{"schema":2}')).rejects.toThrow(/schema/);
  });

  test('deleteAllData leaves an empty, ready store', async () => {
    const s = await fresh();
    await s.loadSeed();
    await s.deleteAllData();
    expect(s.ready).toBe(true);
    expect(s.state.transactions).toEqual([]);
    const again = new AppStore();
    await again.init(s.dbName);
    expect(again.state.transactions).toEqual([]);
  });

  test('patchRow undoes exactly the keys it touched and redoes them', async () => {
    const s = await fresh();
    await s.loadSeed();
    await s.patchRow<Category>('categories', 'cat_fun', { goal: 99 }, 'goal Fun');
    await s.patchRow<Category>('categories', 'cat_fun', { name: 'Play' }, 'rename Fun');
    expect(s.state.categories.find((c) => c.id === 'cat_fun')).toMatchObject({ goal: 99, name: 'Play' });
    expect(await undoStack.undo()).toBe('rename Fun');
    expect(s.state.categories.find((c) => c.id === 'cat_fun')).toMatchObject({ goal: 99, name: 'Fun' });
    await undoStack.undo();
    expect(s.state.categories.find((c) => c.id === 'cat_fun')!.goal).toBe(15000);
    await undoStack.redo();
    expect(s.state.categories.find((c) => c.id === 'cat_fun')!.goal).toBe(99);
    const reloaded = new AppStore();
    await reloaded.init(s.dbName);
    expect(reloaded.state.categories.find((c) => c.id === 'cat_fun')).toMatchObject({ goal: 99, name: 'Fun' });
  });

  test('createRow undo tombstones and redo restores', async () => {
    const s = await fresh();
    await s.loadSeed();
    const row = await s.addCategory('grp_every', 'Coffee');
    expect(row.sortOrder).toBe(2);
    expect(s.state.categories.some((c) => c.id === row.id)).toBe(true);
    await undoStack.undo();
    expect(s.state.categories.some((c) => c.id === row.id)).toBe(false);
    const reloaded = new AppStore();
    await reloaded.init(s.dbName);
    expect(reloaded.state.categories.some((c) => c.id === row.id)).toBe(false);
    await undoStack.redo();
    expect(s.state.categories.some((c) => c.id === row.id)).toBe(true);
  });

  test('fillAllGoals fills every short category as one undo entry', async () => {
    const s = await fresh();
    await s.loadSeed();
    const m = s.currentMonth;
    const before = computeBudget({ ...s.state, currentMonth: m }, m);
    const total = await s.fillAllGoals(m);
    expect(total).toBe(15000 + 20000 + 50000);
    const after = computeBudget({ ...s.state, currentMonth: m }, m);
    expect(after.rta).toBe(before.rta - total);
    expect(after.rows.get('cat_fun')!.assigned).toBe(15000);
    expect(await undoStack.undo()).toBe('fill all goals');
    expect(computeBudget({ ...s.state, currentMonth: m }, m).rta).toBe(before.rta);
    expect(s.state.assignments.some((a) => a.categoryId === 'cat_fun' && a.month === m)).toBe(false);
  });

  test('moveMoney conserves RTA plus available', async () => {
    const s = await fresh();
    await s.loadSeed();
    const m = s.currentMonth;
    const sum = () => { const b = computeBudget({ ...s.state, currentMonth: m }, m); return b.rta + [...b.rows.values()].reduce((t, r) => t + r.available, 0); };
    const before = sum();
    await s.moveMoney('cat_groc', 'cat_fun', m, 10000);
    expect(computeBudget({ ...s.state, currentMonth: m }, m).rows.get('cat_fun')!.available).toBe(20000);
    expect(sum()).toBe(before);
    await s.moveMoney(RTA, 'cat_rent', m, 5000);
    expect(computeBudget({ ...s.state, currentMonth: m }, m).rta).toBe(400000 - 5000);
    expect(sum()).toBe(before);
    expect(await undoStack.undo()).toBe('move $50.00');
  });

  test('addTransaction with a new payee creates both; undo removes both', async () => {
    const s = await fresh();
    await s.loadSeed();
    const draft = { ...emptyDraft('acc_card', '2026-09-06'), outflow: 1200, target: { type: 'category' as const, categoryId: 'cat_groc' } };
    const tx = await s.addTransaction(draft, 'Corner Shop');
    const payee = s.state.payees.find((p) => p.name === 'Corner Shop')!;
    expect(tx).toMatchObject({ amount: -1200, status: 'ok', payeeId: payee.id, source: { kind: 'manual' } });
    expect(await undoStack.undo()).toBe('add transaction');
    expect(s.state.transactions.some((t) => t.id === tx.id)).toBe(false);
    expect(s.state.payees.some((p) => p.id === payee.id)).toBe(false);
    await undoStack.redo();
    expect(s.state.transactions.some((t) => t.id === tx.id)).toBe(true);
    expect(s.state.payees.some((p) => p.id === payee.id)).toBe(true);
    // An existing payee is reused by name or alias, case-insensitively.
    const again = await s.addTransaction(draft, ' grocer ');
    expect(again.payeeId).toBe('pay_grocer');
  });

  test('updateTransaction to a split, deleteTransaction, and the far-side cleared toggle', async () => {
    const s = await fresh();
    await s.loadSeed();
    const d = draftFromTransaction(s.state.transactions.find((t) => t.id === 'seed_t13')!);
    await s.updateTransaction('seed_t13', { ...d, split: true, lines: [
      { target: { type: 'category', categoryId: 'cat_groc' }, amount: -10000, memo: '' },
      { target: { type: 'category', categoryId: 'cat_fun' }, amount: -2345, memo: '' },
    ] });
    expect(s.state.transactions.find((t) => t.id === 'seed_t13')!.lines).toHaveLength(2);
    await undoStack.undo();
    expect(s.state.transactions.find((t) => t.id === 'seed_t13')!.lines).toHaveLength(1);

    await s.deleteTransaction('seed_t13');
    expect(s.state.transactions.some((t) => t.id === 'seed_t13')).toBe(false);
    await undoStack.undo();
    expect(s.state.transactions.some((t) => t.id === 'seed_t13')).toBe(true);

    await s.setCleared('seed_t10', 'acc_card', 'uncleared');
    expect(s.state.transactions.find((t) => t.id === 'seed_t10')!.lines[0]!.farCleared).toBe('uncleared');
    expect(s.state.transactions.find((t) => t.id === 'seed_t10')!.cleared).toBe('cleared');
    await s.setCleared('seed_t10', 'acc_chq', 'uncleared');
    expect(s.state.transactions.find((t) => t.id === 'seed_t10')!.cleared).toBe('uncleared');
  });

  test('confirmTransaction needs a category; confirmAll is one entry', async () => {
    const s = await fresh();
    await s.loadSeed();
    await expect(s.confirmTransaction('seed_t14')).rejects.toThrow(/category/);
    await s.confirmTransaction('seed_t14', { type: 'category', categoryId: 'cat_fun' });
    expect(s.state.transactions.find((t) => t.id === 'seed_t14')).toMatchObject({ status: 'ok', lines: [{ categoryId: 'cat_fun', amount: -4200, memo: '' }] });
    await s.confirmAll([{ id: 'seed_t15', target: { type: 'category', categoryId: 'cat_groc' } }]);
    expect(s.state.transactions.filter((t) => t.status === 'new')).toHaveLength(0);
    expect(await undoStack.undo()).toBe('confirm 1 transactions');
    expect(s.state.transactions.find((t) => t.id === 'seed_t15')!.status).toBe('new');
  });

  test('a claim-based split keeps its lines on other edits and re-derives from the stored total when the share changes', async () => {
    const s = await fresh();
    await s.loadSeed();
    const person = await s.addAccount('Roomie', 'person', true);
    await s.commitEdits([{ table: 'claims', id: 'k1', create: { date: '2026-09-03', total: 20000, paid: 12345, percent: 50, description: 'Grocer', status: 'open' } }], 'claim');
    await s.applyClaim('k1', 'seed_t13', person.id);
    const tx = () => s.state.transactions.find((t) => t.id === 'seed_t13')!;
    expect(tx().shared).toEqual({ accountId: person.id, percent: 50, total: 20000 });
    expect(tx().lines).toEqual([{ amount: -10000, memo: '', categoryId: 'cat_groc' }, { transferAccountId: person.id, amount: -2345, memo: '' }]);
    await s.updateTransaction('seed_t13', { ...draftFromTransaction(tx()), memo: 'edited' });
    expect(tx().memo).toBe('edited');
    expect(tx().lines[0]!.amount).toBe(-10000);
    await s.updateTransaction('seed_t13', draftFromTransaction(tx()), undefined, { accountId: person.id, percent: 25 });
    expect(tx().lines).toEqual([{ amount: -15000, memo: '', categoryId: 'cat_groc' }, { transferAccountId: person.id, amount: 2655, memo: '' }]);
    expect(tx().shared).toEqual({ accountId: person.id, percent: 25, total: 20000 });
    await expect(s.applyClaim('k1', 'seed_t13', person.id)).rejects.toThrow(/no longer open/);
  });

  test('assignments before the cutover are refused without touching the undo stack', async () => {
    const s = await fresh();
    await s.importYnab(fixtureBuild());
    const depth = undoStack.entries.length;
    await expect(s.setAssigned(s.state.categories[0]!.id, '2026-08', 100)).rejects.toThrow(/before the cutover/);
    expect(undoStack.entries.length).toBe(depth);
    expect(s.state.assignments.some((a) => a.month === '2026-08' && a.amount === 100)).toBe(false);
  });

  test('loan terms post interest rows once per elapsed month; set-balance writes the difference', async () => {
    const s = await fresh();
    await s.loadSeed();
    const loan = await s.addAccount('Family loan', 'loan', false);
    await s.addTransaction({ ...emptyDraft(loan.id, '2026-06-01'), outflow: 100000, cleared: 'cleared' }, 'Opening');
    await s.setLoanTerms(loan.id, { annualRatePct: 12, standardPayment: 10000, generateInterest: true, interestDay: 15 });
    const posted = await s.runInterestSweep('2026-08-20');
    const rows = () => s.state.transactions.filter((t) => t.accountId === loan.id && t.memo === 'Interest').sort((a, b) => (a.date < b.date ? -1 : 1));
    expect(rows().map((t) => [t.date, t.amount])).toEqual([['2026-06-15', -1000], ['2026-07-15', -1010], ['2026-08-15', -1020]]);
    expect(posted).toBe(0);   // setLoanTerms already swept up to today; the explicit earlier date adds nothing new
    expect(await s.runInterestSweep('2026-08-20')).toBe(0);
    expect(s.state.payees.some((p) => p.name === 'Interest')).toBe(true);

    // A deleted interest row stays deleted: the sweep must not re-mint it.
    const gone = rows()[0]!;
    await s.deleteTransaction(gone.id);
    expect(await s.runInterestSweep('2026-08-20')).toBe(0);
    expect(s.state.transactions.some((t) => t.id === gone.id)).toBe(false);

    const before = s.state.transactions.length;
    const adj = await s.setBalance('acc_inv', 60000, 'The Ether', 'cat_save');
    expect(adj).toMatchObject({ accountId: 'acc_inv', amount: 10000, status: 'ok' });
    expect(adj!.lines[0]!.categoryId).toBe('cat_save');
    expect(s.state.transactions.length).toBe(before + 1);
    expect(s.state.settings.adjustment).toEqual({ payeeName: 'The Ether', categoryId: 'cat_save' });
    expect(await s.setBalance('acc_inv', 60000, 'The Ether')).toBeNull();
  });

  test('mergePayees repoints transactions, keeps aliases, and undoes as one', async () => {
    const s = await fresh();
    await s.loadSeed();
    await s.mergePayees(['pay_arcade', 'pay_mystery'], 'pay_arcade');
    expect(s.state.payees.some((p) => p.id === 'pay_mystery')).toBe(false);
    expect(s.state.payees.find((p) => p.id === 'pay_arcade')!.aliases).toEqual(['mystery']);
    expect(s.state.transactions.find((t) => t.id === 'seed_t14')!.payeeId).toBe('pay_arcade');
    expect(await undoStack.undo()).toBe('merge 2 payees');
    expect(s.state.payees.some((p) => p.id === 'pay_mystery')).toBe(true);
    expect(s.state.transactions.find((t) => t.id === 'seed_t14')!.payeeId).toBe('pay_mystery');
    expect(s.state.payees.find((p) => p.id === 'pay_arcade')!.aliases).toEqual([]);
    expect(s.ensurePayee('MYSTERY').id).toBe('pay_mystery');
  });

  test('sync: connect pushes, every write requests a sync, a second device pulls the edit, disconnect stops it', async () => {
    const client = new FakeClient();
    const a = await fresh();
    a.clientFactory = () => client;
    a.syncDebounceMs = 5;
    await a.loadSeed();
    await a.connectSync({ owner: 'o', repo: 'magpie-data', token: 'tok' });
    expect(a.syncStatus).toBe('idle');
    expect(a.syncTarget).toEqual({ owner: 'o', repo: 'magpie-data' });
    expect(client.files.has('active.json')).toBe(true);
    expect(JSON.stringify(await a.exportJson())).not.toContain('tok');

    const before = client.puts.length;
    await a.setAssigned('cat_fun', a.currentMonth, 12300);
    await settle();
    expect(client.puts.slice(before)).toEqual(['assignments.json']);
    // Undoing a brand-new assignment tombstones it and that travels too.
    await a.setAssigned('cat_util', '2027-01', 5);
    await settle();
    const mid = client.puts.length;
    await undoStack.undo();
    await settle();
    expect(client.puts.slice(mid)).toEqual(['assignments.json']);

    const b = await fresh();
    b.clientFactory = () => client;
    await b.connectSync({ owner: 'o', repo: 'magpie-data', token: 'tok' });
    expect(b.state.assignments.find((x) => x.categoryId === 'cat_fun' && x.month === a.currentMonth)!.amount).toBe(12300);
    expect(b.state.transactions).toHaveLength(a.state.transactions.length);

    // A reopened store resumes syncing from the device config without asking again.
    const again = new AppStore();
    again.clientFactory = () => client;
    await again.init(a.dbName);
    expect(again.syncTarget).toEqual({ owner: 'o', repo: 'magpie-data' });

    await a.disconnectSync();
    expect(a.syncStatus).toBe('disabled');
    const putsAfter = client.puts.length;
    await a.setAssigned('cat_fun', a.currentMonth, 100);
    await settle();
    expect(client.puts.length).toBe(putsAfter);
  });

  test('sync: a rejected token never saves a config', async () => {
    const s = await fresh();
    s.clientFactory = () => Object.assign(new FakeClient(), { checkAuth: async () => ({ ok: false, error: 'Token rejected' }) });
    await expect(s.connectSync({ owner: 'o', repo: 'r', token: 'bad' })).rejects.toThrow(/rejected/);
    expect(s.syncStatus).toBe('disabled');
  });

  test('setAssigned creates a row where none existed and undo removes it', async () => {
    const s = await fresh();
    await s.loadSeed();
    const m = s.currentMonth;
    await s.setAssigned('cat_fun', m, 5000);
    const find = () => s.state.assignments.find((a) => a.categoryId === 'cat_fun' && a.month === m);
    expect(find()!.amount).toBe(5000);
    await undoStack.undo();
    expect(find()).toBeUndefined();
  });
});
