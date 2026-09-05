import { describe, expect, test, vi } from 'vitest';
import { SyncEngine, type ClientLike, type FileCache } from './engine';
import { AuthError, ConflictError, GithubClient, type RemoteFile, type RemoteFileEntry } from './githubClient';
import { fromFiles, SCHEMA_VERSION } from './files';
import { fullSnapshot } from './files.test';
import type { Snapshot } from '../storage/repo';

/** In-memory Contents API: listing, get, put with optimistic shas, optional one-shot conflicts. */
class FakeClient implements ClientLike {
  files = new Map<string, { json: unknown; sha: string }>();
  puts: string[] = [];
  gets: string[] = [];
  conflictOnce = new Set<string>();
  private n = 0;
  async listFiles(): Promise<RemoteFileEntry[]> { return [...this.files].map(([path, f]) => ({ path, sha: f.sha })); }
  async getFile(path: string): Promise<RemoteFile | null> { this.gets.push(path); const f = this.files.get(path); return f ? { json: JSON.parse(JSON.stringify(f.json)), sha: f.sha } : null; }
  async putFile(path: string, json: unknown, sha?: string): Promise<string> {
    if (this.conflictOnce.delete(path)) throw new ConflictError(`conflict ${path}`);
    const existing = this.files.get(path);
    if (existing && existing.sha !== sha) throw new ConflictError(`stale sha ${path}`);
    const next = `sha${++this.n}`;
    this.files.set(path, { json: JSON.parse(JSON.stringify(json)), sha: next });
    this.puts.push(path);
    return next;
  }
}

function harness(local: Snapshot, client = new FakeClient()) {
  const state = { local };
  let cache: FileCache | null = null;
  const saved: Snapshot[] = [];
  const slept: number[] = [];
  const engine = new SyncEngine({
    client,
    loadLocal: async () => state.local,
    saveLocal: async (s) => { saved.push(s); state.local = s; },
    loadCache: async () => cache,
    saveCache: async (c) => { cache = c; },
    now: () => new Date('2026-09-05T12:00:00Z'),
    sleep: async (ms) => { slept.push(ms); },
    debounceMs: 1,
  });
  const statuses: string[] = [];
  engine.onStatus = (s, d) => statuses.push(d ? `${s}:${d}` : s);
  return { engine, client, state, saved, slept, statuses, cacheOf: () => cache };
}

describe('SyncEngine', () => {
  test('first sync pushes every file; an unchanged second sync pushes nothing and downloads nothing', async () => {
    const h = harness(fullSnapshot());
    await h.engine.syncNow();
    expect(h.client.puts.sort()).toEqual(['active.json', 'assignments.json', 'history.json', 'meta.json', 'tx-2025.json', 'tx-2026.json']);
    expect(h.statuses).toEqual(['syncing', 'idle']);
    expect(h.engine.lastSyncAt).not.toBeNull();
    const before = h.client.puts.length;
    await h.engine.syncNow();
    expect(h.client.puts.length).toBe(before);
    expect(h.client.gets).toEqual([]);   // shas matched the cache, so nothing was re-fetched
    expect(h.saved).toEqual([]);
  });
  test('a remote-newer row is persisted locally without a push; a local-newer row is pushed', async () => {
    const client = new FakeClient();
    const a = harness(fullSnapshot(), client);
    await a.engine.syncNow();
    // Another device renames the payee with a newer stamp.
    const remote = JSON.parse(JSON.stringify(client.files.get('active.json')!.json)) as { payees: { name: string; updatedAt: number }[] };
    remote.payees[0]!.name = 'Grocer Co';
    remote.payees[0]!.updatedAt += 10;
    client.files.set('active.json', { json: remote, sha: 'other-device' });
    const putsBefore = client.puts.length;
    await a.engine.syncNow();
    expect(a.saved).toHaveLength(1);
    expect(a.state.local.payees[0]!.name).toBe('Grocer Co');
    expect(client.puts.length).toBe(putsBefore);
    // Now a local edit to a category goes up, and only active.json moves.
    a.state.local = { ...a.state.local, categories: [{ ...a.state.local.categories[0]!, goal: 1, updatedAt: a.state.local.categories[0]!.updatedAt + 20 }] };
    await a.engine.syncNow();
    expect(client.puts.slice(putsBefore)).toEqual(['active.json']);
  });
  test('a sha conflict re-pulls and retries with backoff, then succeeds', async () => {
    const h = harness(fullSnapshot());
    h.client.conflictOnce.add('assignments.json');
    await h.engine.syncNow();
    expect(h.slept).toEqual([500]);
    expect(h.engine.status).toBe('idle');
    expect(h.client.files.has('assignments.json')).toBe(true);
    // Files that landed before the conflict were remembered, so the retry did not re-download them.
    expect(h.cacheOf()!['meta.json']).toBeDefined();
  });
  test('failures park the engine and leave local data alone', async () => {
    const client = new FakeClient();
    client.files.set('meta.json', { json: { schema: SCHEMA_VERSION + 1 }, sha: 's' });
    const h = harness(fullSnapshot(), client);
    await h.engine.syncNow();
    expect(h.engine.status).toBe('error');
    expect(h.engine.statusDetail).toMatch(/newer Magpie/);
    expect(h.saved).toEqual([]);
    expect(client.puts).toEqual([]);
    const auth = harness(fullSnapshot(), Object.assign(new FakeClient(), { listFiles: async () => { throw new AuthError('GitHub auth failed (401)'); } }));
    await auth.engine.syncNow();
    expect(auth.engine.status).toBe('error');
    const offline = harness(fullSnapshot(), Object.assign(new FakeClient(), { listFiles: async () => { throw new TypeError('Failed to fetch'); } }));
    await offline.engine.syncNow();
    expect(offline.engine.status).toBe('offline');
  });
  test('a disposed engine neither syncs nor reports', async () => {
    const h = harness(fullSnapshot());
    h.engine.dispose();
    await h.engine.syncNow();
    expect(h.statuses).toEqual([]);
    expect(h.client.puts).toEqual([]);
  });
  test('an empty remote merges to the local snapshot exactly', async () => {
    const h = harness(fullSnapshot());
    await h.engine.syncNow();
    const files = Object.fromEntries([...h.client.files].map(([p, f]) => [p, f.json]));
    expect(fromFiles(files).transactions).toHaveLength(2);
  });
});

describe('GithubClient against a mocked fetch', () => {
  const cfg = { owner: 'o', repo: 'r', token: 't' };
  const respond = (routes: Record<string, () => Response>) => vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(url)}`;
    const hit = Object.entries(routes).find(([k]) => key.startsWith(k));
    if (!hit) throw new Error(`unrouted ${key}`);
    return hit[1]();
  }));
  test('a 404 root is empty only when the repo itself answers', async () => {
    respond({ 'GET https://api.github.com/repos/o/r/contents/': () => new Response('', { status: 404 }), 'GET https://api.github.com/repos/o/r': () => new Response('{}', { status: 200 }) });
    expect(await new GithubClient(cfg).listFiles()).toEqual([]);
    respond({ 'GET https://api.github.com/repos/o/r/contents/': () => new Response('', { status: 404 }), 'GET https://api.github.com/repos/o/r': () => new Response('', { status: 404 }) });
    await expect(new GithubClient(cfg).listFiles()).rejects.toBeInstanceOf(AuthError);
  });
  test('a file over 1 MB comes back empty inline and is fetched from the blob endpoint', async () => {
    respond({
      'GET https://api.github.com/repos/o/r/contents/tx-2026.json': () => new Response(JSON.stringify({ content: '', encoding: 'none', sha: 'big', size: 2000000 }), { status: 200 }),
      'GET https://api.github.com/repos/o/r/git/blobs/big': () => new Response(JSON.stringify({ schema: 1, transactions: [] }), { status: 200 }),
    });
    expect(await new GithubClient(cfg).getFile('tx-2026.json')).toEqual({ json: { schema: 1, transactions: [] }, sha: 'big' });
    vi.unstubAllGlobals();
  });
});
