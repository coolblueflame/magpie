# Phase 5: Sync and Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every change syncs to a private GitHub data repo (the OC model, PB §2.6) so the data survives the browser and follows Ben to Windows; the app deploys to GitHub Pages from CI; the app repo can go public.

**Architecture:** `src/lib/sync/` copied from Organized Chaos and trimmed to Magpie's snapshot: `githubClient.ts` (Contents API, verbatim), `files.ts` (layout: `meta.json`, `active.json`, `assignments.json`, `history.json`, `tx-<year>.json`; schema gate; tombstone compaction), `merge.ts` (newest-wins with the four-step tie-break, generic over tables), `engine.ts` (pull → merge → persist → push, sha cache, backoff, conflict retry; verbatim). The repo gains `replaceAll` (write-back re-applying `supersedes` per row in one transaction) and a device-local kv for the token and the file cache. The store owns one engine, requests a sync after every write, and mirrors status for Settings.

**Spec:** §7 (sync and deploy), §3 rows, PB §2.1 (build, CI), §2.6, §2.7, §2.9, §6.1 (Ben's day-one list).

## Global Constraints

As before. Plus: the token lives only in the `device` table and never in a synced file or the JSON backup; every sync failure leaves local data untouched; fixtures use realistic timestamps (tombstone compaction eats anything stamped `1`); nothing in the public repo names Ben's institutions or data repo contents.

## Ben's checklist (only he can do these)

- [ ] Create the private repo `coolblueflame/magpie-data`; add `meta.json` containing `{ "schema": 1 }` (or leave it empty; the first sync writes it).
- [ ] Mint a fine-grained PAT: Contents read/write, that repo only (`docs/BEN-PAT-SETUP.md`).
- [ ] Re-read `CLAUDE.md`, then make `coolblueflame/magpie` public and enable Pages (Source: GitHub Actions).
- [ ] Paste the token in Settings on each machine.

---

### Task 1: files and merge (`src/lib/sync/files.ts`, `merge.ts`, tests)

```ts
export const SCHEMA_VERSION = 1;
export class SchemaTooNewError extends Error {}
export type SyncFilePayloads = Record<string, unknown>;
export function toFiles(snap: Snapshot, now: Date): SyncFilePayloads     // compacts tombstones older than 90 days
export function fromFiles(files: SyncFilePayloads): Snapshot             // unions tx-<year> files, dedupes by id keeping the newest updatedAt
export function canonical(v: unknown): string
export function supersedes(incoming: Row, mine: Row): boolean
export function mergeSnapshots(local: Snapshot, remote: Snapshot): { merged: Snapshot; localChanged: boolean; remoteChanged: boolean }
```
- [ ] Tests: pick rules and tie-breaks; commutative and idempotent over random rows; change flags; key order does not count as change; round trip with every optional field populated; compaction with realistic stamps; schema too new throws; year layout; dedupe across files.
- [ ] Commit.

### Task 2: client and engine (`githubClient.ts`, `engine.ts`, tests)

Copy OC's files. `engine.ts` differences: orphan rewrite applies to `tx-` files (`{ schema, transactions: [] }`); `SyncStatus` unchanged. Tests with an in-memory fake client: first sync pushes every file; a second sync with nothing changed pushes nothing; a remote-newer row wins and `saveLocal` is called with it; a local-newer row is pushed; a sha conflict re-pulls and retries then succeeds; a 404 root with an accessible repo is empty, a 404 with an inaccessible repo is `AuthError`; a > 1 MB file falls back to the blob endpoint (mock `fetch`); a disposed engine reports no status; schema-too-new parks the engine in `error` without writing.
- [ ] Commit.

### Task 3: repo write-back and store wiring

Repo: `replaceAll(snap: Snapshot)` inside one `rw` transaction over every table: for each incoming row, keep it only if `supersedes(incoming, mine)` (or mine is absent); settings by stamp (`pickSingleton` semantics: write when the incoming stamp is newer). `getDevice(key)` / `setDevice(key, value)` on the `device` table for `syncConfig` and `fileCache`.
Store: `syncStatus`, `syncDetail`, `lastSyncAt` (`$state`); `connectSync({ owner, repo, token })` → `checkAuth` → save config → start engine → `syncNow`; `disconnectSync()` → dispose, clear config and cache; `syncNow()`; the engine's `loadLocal` = `repo.loadSnapshot`, `saveLocal` = `repo.replaceAll` then `hydrate()`; a private `touched()` called at the end of every write path (`writePatch`, `writeAssigned`, `commitEdits`, `importRows` callers) → `engine?.requestSync()`. `exportJson` must not include the device table. `deleteAllData` disposes the engine and clears the device table.
- [ ] Tests: replaceAll keeps the newer of each row and never resurrects a tombstone with an older incoming; a store with a fake engine requests a sync after `setAssigned`, `addTransaction`, `importYnab`; a pulled change reaches the mirror.
- [ ] Commit.

### Task 4: Settings, App hook, e2e

Settings: a Sync section with `sync-owner`, `sync-repo` (default `magpie-data`), `sync-token`, `sync-connect`, `sync-disconnect`, `sync-now`, `sync-status`, `sync-last`, and the honest privacy paragraph (the only network destination is api.github.com; GitHub can read a private repo; git history keeps deleted data; the token is plaintext on this device and never synced; never make the data repo public). App: `visibilitychange` visible → `app.syncNow()`. e2e `sync.spec.ts`: route-stub `https://api.github.com/**` with an in-memory contents store (listing, get, put with shas, 409 once); connect, edit, expect a PUT of `assignments.json`; reload a fresh profile with the same stub and expect the edit to come back.
- [ ] Commit.

### Task 5: PWA, icons, CI, README, docs

`vite-plugin-pwa` (autoUpdate, manifest name Magpie, theme `#0a0d12`, icons 192/512 PNG rendered from an inline SVG via a Playwright script in `tools/`), `registerSW` in `main.ts`, an "update installed, reload" line from `needRefresh`. `.github/workflows/deploy.yml` from OC (check → vitest → chromium e2e → build → Pages). `README.md` (what it is, how to run, no personal detail). `docs/BEN-PAT-SETUP.md`. `CLAUDE.md` build section: deploy and sync notes. Playwright keeps `serviceWorkers: 'block'`.
- [ ] Full gates; commit; push; memory.
