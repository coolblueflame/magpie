import { beforeEach, describe, expect, test } from 'vitest';
import { AppStore } from './app.svelte';
import { undoStack } from './undo.svelte';
import { seedData } from '../domain/seed';
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
