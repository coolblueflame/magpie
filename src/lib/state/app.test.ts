import { beforeEach, describe, expect, test } from 'vitest';
import { AppStore } from './app.svelte';
import { undoStack } from './undo.svelte';
import { seedData } from '../domain/seed';

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
