/**
 * Sync orchestration (spec §7, PB §2.6): pull → merge → persist locally → push changed
 * files with their shas; on a sha conflict, re-pull and retry (bounded). Local
 * usability is sacred — every failure path leaves local data untouched and
 * just parks the engine in 'offline'/'error' until the next trigger.
 */
import { AuthError, ConflictError, type RemoteFileEntry, type RemoteFile } from './githubClient';
import { fromFiles, ROW_TABLES, SCHEMA_VERSION, toFiles, type SyncFilePayloads } from './files';
import type { Snapshot as RemoteSnapshot } from '../storage/repo';
import { mergeSnapshots } from './merge';

export type SyncStatus = 'disabled' | 'idle' | 'syncing' | 'error' | 'offline';

/** Structural subset of GithubClient so tests inject an in-memory fake. */
export interface ClientLike {
  listFiles(): Promise<RemoteFileEntry[]>;
  getFile(path: string): Promise<RemoteFile | null>;
  putFile(path: string, json: unknown, sha?: string): Promise<string>;
}

export interface EngineDeps {
  client: ClientLike;
  loadLocal: () => Promise<RemoteSnapshot>;
  saveLocal: (snap: RemoteSnapshot) => Promise<void>;
  debounceMs?: number;
  now?: () => Date;
  /** Test seam for the retry backoff. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Device-local cache of already-downloaded files, keyed by path. Optional:
   * without it the engine simply fetches everything every time, as before.
   */
  loadCache?: () => Promise<FileCache | null>;
  saveCache?: (cache: FileCache) => Promise<void>;
}

/**
 * What we last saw at each path. Git object ids are content hashes, so an
 * unchanged sha is a guarantee — not a hint — that the bytes are unchanged,
 * which makes skipping the download safe rather than merely optimistic.
 */
export type FileCache = Record<string, { sha: string; json: unknown }>;

/**
 * Backoff between conflict retries. GitHub's Contents API is eventually
 * consistent — verified live 2026-07-26: a GET issued immediately after a
 * successful PUT can still return the PREVIOUS content and sha. Retrying
 * instantly just re-reads the same stale view and burns an attempt, so each
 * retry waits a beat first. (A stale read can never lose data — the merge is
 * union + newest-wins — it only costs us a conflict.)
 */
/*
 * Waits scale up as well as out. The original 250/750/1750 assumed a cycle
 * measured in milliseconds; with a large library a full cycle can run for
 * many seconds, so the entire retry budget used to expire while the other
 * device was still mid-push, and the sync gave up with "conflict would not
 * settle" every time.
 */
const RETRY_BACKOFF_MS = [500, 1500, 4000, 9000];
const MAX_CONFLICT_RETRIES = RETRY_BACKOFF_MS.length + 1;

export class SyncEngine {
  status: SyncStatus = 'idle';
  statusDetail = '';
  lastSyncAt: number | null = null;
  /** UI subscribes for reactive status display. */
  onStatus?: (status: SyncStatus, detail: string) => void;

  private debounceMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private pending = false;
  private sleep: (ms: number) => Promise<void>;

  constructor(private deps: EngineDeps) {
    this.debounceMs = deps.debounceMs ?? 4000;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private disposed = false;

  private setStatus(status: SyncStatus, detail = ''): void {
    // A disposed engine has no business talking to the UI: a cycle that was
    // mid-flight when the user disconnected used to finish later and overwrite
    // the store's 'disabled' with its own 'idle'.
    if (this.disposed) return;
    this.status = status;
    this.statusDetail = detail;
    this.onStatus?.(status, detail);
  }

  /** Debounced trigger — call after every mutation. */
  requestSync(): void {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.syncNow(), this.debounceMs);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
  }

  /** One full cycle; if one is mid-flight, queues a trailing run instead. */
  async syncNow(): Promise<void> {
    if (this.disposed) return;
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    clearTimeout(this.timer);
    this.setStatus('syncing');
    try {
      for (let attempt = 1; ; attempt++) {
        if (this.disposed) return; // severed mid-flight: stop pushing, quietly
        const conflicted = await this.cycleOnce();
        if (!conflicted) break;
        if (attempt >= MAX_CONFLICT_RETRIES) {
          throw new ConflictError('unresolved after retries');
        }
        await this.sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 1750);
      }
      this.lastSyncAt = Date.now();
      this.setStatus('idle');
    } catch (e) {
      if (e instanceof AuthError) this.setStatus('error', e.message);
      else if (e instanceof ConflictError) this.setStatus('error', 'sync conflict would not settle');
      // Only a NETWORK TypeError means offline. fetch() rejects with a
      // browser-specific message ("Failed to fetch" / "Load failed" /
      // "NetworkError when attempting…"); any other TypeError is a bug in our
      // own cycle and blaming the network would bury it.
      else if (e instanceof TypeError && /fetch|network|load failed|connection/i.test(e.message)) {
        this.setStatus('offline', 'network unreachable');
      }
      else this.setStatus('error', e instanceof Error ? e.message : String(e));
    } finally {
      this.running = false;
      if (this.pending && !this.disposed) {
        this.pending = false;
        void this.syncNow();
      }
    }
  }

  /** Returns true if a sha conflict happened (caller retries with fresh remote). */
  private async cycleOnce(): Promise<boolean> {
    // Every await below is a point where the user may have disconnected or deleted
    // everything; a disposed cycle must not touch storage or the remote again.
    const gone = () => this.disposed;
    const entries = await this.deps.client.listFiles();
    if (gone()) return false;
    const cache: FileCache = (await this.deps.loadCache?.()) ?? {};
    const nextCache: FileCache = {};
    const remoteFiles = new Map<string, RemoteFile>();
    for (const entry of entries.filter((f) => f.path.endsWith('.json'))) {
      // The listing already told us the content hash. If it matches what we
      // downloaded last time, the bytes cannot have changed, so re-fetching is
      // pure waste — and with years of logbook that waste was the bulk of
      // every sync (measured at ~10MB on a large library).
      const cached = cache[entry.path];
      if (cached && cached.sha === entry.sha) {
        remoteFiles.set(entry.path, { json: cached.json, sha: entry.sha });
        nextCache[entry.path] = cached;
        continue;
      }
      const file = await this.deps.client.getFile(entry.path);
      if (gone()) return false;
      if (file) {
        remoteFiles.set(entry.path, file);
        nextCache[entry.path] = { sha: file.sha, json: file.json };
      }
    }
    // Paths absent from the listing are gone; letting them fall out of
    // nextCache keeps the cache from growing forever.
    await this.deps.saveCache?.(nextCache);
    const payloads: SyncFilePayloads = {};
    for (const [path, file] of remoteFiles) payloads[path] = file.json;

    const remoteSnap = fromFiles(payloads);
    const local = await this.deps.loadLocal();
    if (gone()) return false;
    const { merged, localChanged, remoteChanged } = mergeSnapshots(local, remoteSnap);

    if (localChanged) await this.deps.saveLocal(merged);
    if (gone()) return false;
    if (!remoteChanged) return false;

    // A tombstone the remote still carries must travel however old it is, or the device
    // that compacted it and the device that never saw it would trade the row forever.
    const remoteIds = new Set<string>();
    for (const t of ROW_TABLES) for (const r of remoteSnap[t] as { id: string }[]) remoteIds.add(r.id);
    const desired = toFiles(merged, (this.deps.now ?? (() => new Date()))(), { keep: remoteIds });
    /*
      A year file whose last transaction left it (re-dated, or compacted away
      as a tombstone) drops out of `desired`, but the remote still holds its
      final contents and fromFiles re-unions them every cycle: a permanent
      phantom `remoteChanged` and a resurrection trap. So an orphaned file is
      rewritten EMPTY rather than deleted: rewriting empty cannot destroy
      anything even if the orphan test is one day wrong.
    */
    for (const path of remoteFiles.keys()) {
      if (path.startsWith('tx-') && !(path in desired)) {
        desired[path] = { schema: SCHEMA_VERSION, transactions: [] };
      }
    }
    try {
      for (const [path, payload] of Object.entries(desired)) {
        const existing = remoteFiles.get(path);
        if (existing && JSON.stringify(existing.json) === JSON.stringify(payload)) continue;
        if (gone()) return false;
        const sha = await this.deps.client.putFile(path, payload, existing?.sha);
        // Record what we just wrote, so the next cycle recognises our own push
        // instead of downloading it straight back.
        nextCache[path] = { sha, json: payload };
      }
      await this.deps.saveCache?.(nextCache);
    } catch (e) {
      if (e instanceof ConflictError) {
        // The shas recorded for files that DID land before the conflict must
        // survive the abort — dropping them made the retry re-download our own
        // successful pushes as if another device had written them.
        await this.deps.saveCache?.(nextCache);
        return true;
      }
      throw e;
    }
    return false;
  }
}
