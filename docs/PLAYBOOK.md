# The Organized Chaos playbook

A handoff from the Claude session that built Organized Chaos (2026-07-26 to 2026-09-02) to the
session that will build Ben's budgeting app. It distils one project's worth of architecture
decisions and expensive lessons into what transfers: a local-first, multi-device, no-hosting PWA
whose data is precious. A budgeting app has exactly that shape, so most of this applies verbatim.

It pairs with a product-design document Ben has from Claude Chat. This document is deliberately
silent on what the budgeting app should *do*; it covers how to build it so it survives real use.

---

## 0. How to use this document

1. Read it once, fully, before scaffolding anything. Section 2 is the recipe; copy it.
2. Seed the new repo's `CLAUDE.md` from section 6.3. Ben's global `CLAUDE.md` still applies on
   top; this document only adds what the project taught beyond it.
3. Treat section 4 as a citation index: before debugging something that smells familiar, grep
   this file. Most of these cost a real debugging round the first time.
4. Where this document and the running code disagree, the code wins and this document is
   stale. Verify before trusting any specific version number or API claim; several claims in
   the lesson bank were themselves corrections of stale memory.

Conventions: "Ben" is the user. "Field report" is Ben's short note about something he hit on a
real device; field reports preempt all queued work. "Teeth" means a fix's test was shown to
fail without the fix and pass with it.

---

## 1. What was built, for calibration

- 284 commits over 39 days, one developer session plus Ben's field reports. Suite at handoff:
  650 unit tests and 251 end-to-end tests, all gating every deploy.
- Ben's real library: ~25,000 tasks including nine years of imported history, 64 lists,
  124 tags. Every performance rule below was learned against that data on a phone.
- Two repos. Public app repo (GitHub Pages via Actions). Private data repo that is the sync
  target and the "server" for scheduled push. One optional 90-line Cloudflare Worker for
  exact-time alarms. No other infrastructure, no accounts beyond GitHub and Cloudflare free.
- The architecture survived: one accidental 700-row bulk action, one import with timestamps
  31 years in the future, one seven-hour GitHub outage, a sync payload that turned out to be
  1.5 MB per edit, two devices straddling a day rollover, and a phone in a pocket. Each of those
  is a lesson below.

---

## 2. The architecture recipe

### 2.1 Stack and versions

Pin these on day one; the combination is known-good together.

| Piece | Version at handoff | Notes |
| --- | --- | --- |
| Svelte | ^5.56 (runes) | `$state` / `$derived` / `$effect` / `$state.snapshot` everywhere; no stores API |
| TypeScript | ^5.9 | **TypeScript 7.x breaks svelte-check.** Stay on 5 until svelte-check says otherwise |
| Vite | ^6.4 | |
| vite-plugin-pwa | ^1.3 | `generateSW` strategy, `registerType: 'autoUpdate'` |
| Dexie | ^4.4 | IndexedDB wrapper |
| Vitest | ^3.2 | `environment: 'node'` + `fake-indexeddb/auto` in a setup file |
| Playwright | ^1.62 | chromium + iPhone-15 webkit locally; chromium only on CI |
| svelte-check | ^4.7 | first gate, always |
| Node | 22 on CI | |
| nanoid | ^5 | row ids |

`tsconfig.json`: extend `@tsconfig/svelte`, `strict`, `noUncheckedIndexedAccess`,
`moduleResolution: bundler`, `target ES2022`.

Build config that matters (copy from the OC repo's `vite.config.ts` and `playwright.config.ts`):

- `base: '/<repo-name>/'` because GitHub Pages serves a project site under a path. Every asset,
  the manifest `start_url` and `scope`, and the Playwright `baseURL` carry it.
- Workbox `importScripts: ['sw-push.js?v=<content hash>']`. The hash is computed in
  `vite.config.ts` from the file's bytes. Without it, editing the push handler changes nothing
  the browser can see: a service worker only reinstalls when `sw.js` itself changes, and
  workbox writes a bare import URL. A push-handler change once deployed green and could never
  have reached a phone.
- `maximumFileSizeToCacheInBytes` raised if any asset (a wasm, a big font) exceeds 2 MB.
- `define: { __APP_VERSION__ }` from `package.json` so Settings can print the running version.
- Playwright `webServer` runs `npm run build && npm run preview`: tests hit the production
  bundle at the real base path. `serviceWorkers: 'block'` globally, because the SW would swallow
  route-stubbed requests and webkit cannot intercept SW-originated fetches; the one PWA spec
  re-enables it explicitly.

CI (`.github/workflows/deploy.yml`): on push to main, `npm ci` → `npm run check` → `npm test` →
`playwright install chromium --with-deps` → `playwright test --project=chromium` →
`npm run build` → Pages artifact → deploy. `concurrency: { group: pages, cancel-in-progress }`
so a superseded run is cancelled rather than deploying stale output. Actions at handoff:
checkout@v7, setup-node@v7, configure-pages@v6, upload-pages-artifact@v5, deploy-pages@v5; each
major was verified upstream as `using: node24` before bumping.

### 2.2 Repo layout and the layer rules

```
src/lib/domain/    pure functions + types, no Svelte, no IO; every file has a .test.ts
src/lib/storage/   db.ts (Dexie schema) + repo.ts (the only thing that touches Dexie)
src/lib/state/     app.svelte.ts (the store), undo.svelte.ts, other runes singletons
src/lib/sync/      githubClient.ts, files.ts, merge.ts, engine.ts
src/lib/ui/        .svelte screens and components, small .ts helpers, fx/
src/tests/setup.ts fake-indexeddb registration
e2e/               Playwright specs, one per feature area
tools/             scripts that run outside the app (reminders cron, worker, repair scripts)
docs/              spec, plans, setup docs for the human
```

The layer rules that held:

- **Domain is pure and exhaustively unit-tested.** Every non-trivial rule (merge, day-bucketing,
  recurrence, search ranking, statistics) is a function of plain data. Screens call the store;
  the store calls domain functions and the repo. Screens never touch the repo or Dexie.
- **One store singleton** (`app`) holding a `$state` mirror of the whole dataset. Every mutation
  goes repo-first (persist), then patches the mirror in place. Screens read the mirror.
- **The mirror holds living rows only.** Tombstones exist on disk and in sync, never in the
  mirror. Anything that needs deletions (statistics, "what was removed") loads them from the
  repo per visit. This was an architectural fact that took a while to remember.
- **Sync is a separate engine** with an injectable client so the whole cycle is unit-testable
  against an in-memory fake, including conflicts and retries.

### 2.3 Row conventions

Every synced row: `{ id, updatedAt, editedAt?, deleted, ...fields }`.

- `id`: nanoid, generated client-side. Rows that two devices could both create for the same
  logical reason (a scheduled recurrence spawning, a month's opening entry) must use a
  **deterministic id** derived from the cause (`sp_<templateId>_<dueTs>`), so both devices mint
  the same row and newest-wins merge collapses them instead of producing twins. This was a real
  bug: two devices each swept a day rollover 1.7 seconds apart, blind to each other.
- `updatedAt` is the merge key and is written as `nextStamp(current) = max(Date.now(), current + 1)`.
  A change must always beat what it changed, even when the row's stamp is in the future
  (imports with bad epochs, clock skew). Never write a bare `Date.now()` as a merge key.
- `editedAt` is a plain wall-clock write time, the honest clock that breaks ties when two
  devices' clamped stamps collide exactly. A side that has one beats a side that lacks one.
- `deleted: true` is a tombstone. Deletes propagate only as tombstones; tombstones are compacted
  out of sync files after 90 days. Test fixtures must use realistic timestamps or compaction
  eats them silently.
- Singletons (settings, current selection, a queue) live in a `kv` table with their own stamp
  and merge by stamp, not by row rule.
- **Settings sync sparse**: only explicit choices are written; defaults are applied at the read
  edge. Otherwise every device pushes a materialised copy of every default and a changed
  default never reaches anyone.
- Field-slimming (dropping `deleted: false`, empty strings, empty arrays from the wire) was
  evaluated and rejected: it needs a perfect rehydrate-on-read or canonical comparisons
  diverge and both sides push forever. Not worth ~17%.

### 2.4 Storage (Dexie) rules

- Index strings list only queryable keys; full objects are stored regardless. Schema changes
  need a new `version()` block with a migration once real data exists.
- **A patch is one read-modify-write inside one `rw` transaction on the same table**, never a
  bare get-then-put. A sync's write-back can commit a newer merged row in the gap, and a patch
  built on the stale read erases that merge with a stamp high enough to propagate the erasure
  everywhere.
- Never read-modify-write past an in-flight insert: eagerly-created rows keep a pending-write
  promise keyed by id, and updates await it first.
- **`$state` proxies cannot be handed to IndexedDB** (`DataCloneError`). `$state.snapshot()` at
  every choke point that writes. Nested objects inside rows are the classic survivor.
- `navigator.storage.persist()` at boot; surface the outcome in Settings so the user knows
  whether the browser may evict them.

### 2.5 The store

- Mirror mutates **in place** (`Object.assign` on the row). Any undo/restore closure must capture
  the fields it needs *before* the patch, and match stack entries by id, never by reference
  (`$state` deep-proxies arrays, so the object handed back is not reference-equal to the stored
  element).
- **Undo arms before the mutation.** With a mirror-first store, "after the await" is already
  too late because the UI keyed off the change. Four separate races taught this.
- Claim-the-draft-before-await: any "create on Enter, also create on blur" pair races when the
  blur lands mid-write and both read the same title. Null the draft synchronously, then await.
- Reentrancy guards on every sweep that can be triggered from more than one door
  (boot, visibilitychange, a timer, a sync completing). Same for imports.
- Boot-time repairs are legitimate and powerful: a self-verifying repair that converges on every
  device (checks the evidence, fixes only if the evidence says so) beats editing the data repo
  by hand, because devices re-upload whatever state they hold.

### 2.6 Sync: a private GitHub repo as the backend

Verified live for six weeks against real multi-device use. Copy it.

**Transport.** GitHub Contents API with a fine-grained personal access token scoped to
Contents: read/write on the one private data repo. CORS and the Authorization preflight work
from a browser (verified 2026-07-26). Headers: `Authorization: Bearer`,
`Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`. Content is base64 of
**pretty-printed** JSON; UTF-8-safe base64 (plain `btoa` chokes on non-Latin1 text).
Pretty-printing costs ~30% over compact and is worth it: each sync is one reviewable commit per
changed file, and the repo's history is the point-in-time backup of the user's whole dataset.

**Token handling.** The token lives only in that device's IndexedDB, never syncs, and the
Settings screen says so. Honest privacy story to tell the user: the only network destination is
`api.github.com`; GitHub can read a private repo; git history retains deleted data; the token
is plaintext on the device. The data repo must never be made public. A setup doc for the human
(`docs/BEN-PAT-SETUP.md` in OC) lists the exact GitHub clicks; write one on day one.

**File layout, sharded from day one.** The Contents API replaces whole files. OC's first layout
put all open rows in one file: measured, every edit uploaded 1.54 MB; git's tiny diffs hid it.
Sharding by a stable hash of the row id (FNV-1a, 16 shards) plus history bucketed by year and
the same hash (8 per year) brought a median edit to 87 KB, 18x less. For a budgeting app:
accounts/categories/rules in `active.json`, live transactions in `tx-<0..15>.json`, and
historical or reconciled transactions in `history-<year>-<0..7>.json` or similar.
`meta.json` holds `{ schema }`.

**Schema version gate.** Bump `SCHEMA_VERSION` whenever the layout changes. A device running an
older build must fail loudly ("update the app") rather than read the new layout as empty and
push its old-shape copy back forever. Mid-migration a row can exist in both the old and new
places, so the reader unions everything and dedupes by id keeping newest.

**Cycle.** Debounced (4 s) after any mutation, plus boot and `visibilitychange` visible:
pull → merge → persist locally → push only files whose content changed, with their shas →
on a sha conflict re-pull and retry with backoff 500/1500/4000/9000 ms. Every failure path
leaves local data untouched and parks the engine in `offline`/`error` until the next trigger.
Local usability is sacred.

**Client details that were all bugs once.**
- Cache `{ path → { sha, json } }` per device and skip downloading files whose listed sha is
  unchanged. Git shas are content hashes, so this is a guarantee, not a hint. Record your own
  pushes into the cache. On a conflict mid-push, save the cache before retrying or the retry
  re-downloads everything.
- Files over 1 MB come back with empty `content` and `encoding: "none"` and a 200. Gate on
  empty content, not the encoding field, and fall back to the git blobs endpoint with
  `Accept: application/vnd.github.raw`.
- A 404 on the root listing is ambiguous: an empty repo, or a private repo the token can no
  longer see (GitHub hides private repos from de-granted tokens instead of answering 401/403).
  One extra request to the repo metadata endpoint disambiguates. Treating it as "empty" once
  wiped the file cache and reported nothing wrong.
- The Contents API is eventually consistent: a GET right after a PUT can return the previous
  content. Retries wait before re-reading.
- `DELETE /contents/{path}` exists; OC deliberately rewrites orphaned files as empty instead,
  because an empty rewrite can never destroy rows if the orphan test is ever wrong.
- The Contents API cannot write workflow files without the `workflow` scope; push data-repo
  workflow changes over an SSH clone.
- A disposed engine must not report status: a cycle mid-flight when the user disconnects used
  to finish later and overwrite `disabled` with `idle`.

**Write-back is not a swap.** `replaceAll(snapshot)` re-runs the merge rule per row at write
time (`supersedes(incoming, mine)`), inside one transaction across all tables. A sync cycle
merges against a snapshot read seconds earlier; a user action in that gap must survive, and a
tombstone must be overruled by a newer edit but never destroyed.

**The round-trip test that earns its keep.** `sameAs()` and the change flags enumerate fields
explicitly; a new snapshot field that is not listed never saves or pushes. Keep a test that
builds a snapshot with every field populated, round-trips it through `toFiles`/`fromFiles`, and
asserts equality; it caught exactly this omission.

### 2.7 Merge rules

Entity-level newest-wins, no field merging. Per id, `pick(a, b)`:

1. larger `updatedAt` wins;
2. tie → the tombstoned/completed side (deterministic, biased toward "done");
3. tie → larger `editedAt` (a side with one beats a side without);
4. tie → canonical-content string comparison, so both sides pick the same one. Preferring
   "mine" leaves each device convinced it is right with different content under the same stamp
   and nothing left to break the deadlock.

Canonical comparison everywhere (`sameAs`, change flags, tie-breaks): key order is layout, not
content, and IndexedDB and JSON disagree on it.

Beyond rows, three merge shapes were needed and each was learned the hard way:

- **Set-like state needs ownership clocks, not union.** A union merge can never take something
  back: a wrongly-granted item resurrected from every stale copy, and reverting the data repo
  cannot fix it because devices re-upload it. Model as `grants: {id → ms}` and
  `revokes: {id → ms}` merged per key by max; held = newest grant beats newest revoke; a legacy
  item with no clock counts as granted at epoch 0; a real grant stamps `max(now, revoke + 1)`.
  One function is the rule, and every path (merge, load, grant, revoke, write-back) goes
  through it.
- **Per-day measurements merge by "earliest reading wins"** (tie → smaller value), and a device
  may only record the day's reading if it has pulled since the day began. Otherwise the stalest
  open tab, which fires the rollover timer first, defines the day's truth.
- **Piggyback on writes that already happen.** When a counter was made device-local to avoid
  "sync churn", Ben pushed back and was right: the row it belonged to was already being written
  on the same action, so syncing it was free. Last-writer-wins may drop an increment on
  concurrent edits; documented and acceptable.

### 2.8 What syncs and what stays on the device

User-owned state syncs: rows, settings choices, achievements/progress, per-day measurements.
Device-owned state does not: pacing and cooldown clocks, "what did this device show recently",
per-device ledgers of what a server was told, view state. The test: would syncing this let one
device's recent event suppress or duplicate another's? Then it stays local (`localStorage`,
ids and timestamps only).

### 2.9 PWA and service worker

- `registerType: 'autoUpdate'`; the app shows "update installed, restart to update" from
  `needRefresh`. Ben's field report: a PWA shows the banner until the standalone app is fully
  quit and relaunched, not merely backgrounded.
- Precache everything needed offline, including any wasm. Verify offline with airplane mode on
  a real phone; Settings shows an "offline ready" line based on `navigator.serviceWorker.controller`.
- Install paths differ per platform and the copy must say so: iOS Safari share → Add to Home
  Screen; macOS Safari File → Add to Dock; Chrome/Edge address-bar install; Firefox never
  installs from a manifest. Phone-phrased copy on a desktop reads as "the feature does not
  exist" (a real report).
- `beforeinstallprompt` does not exist on iOS; verify against current docs before claiming any
  install-prompt capability.

### 2.10 Serverless extras that worked

**Scheduled push digest with no server.** A cron workflow in the *data* repo checks out both
repos, `npm install --no-save web-push`, and runs a script from the *app* repo (so it is
unit-tested by the app's gates) that reads the synced data plus `push-subscriptions.json` and
sends a Web Push. The app subscribes with a VAPID public key that is a constant in the app; the
private key lives only in the data repo's Action secrets (and the Worker's, if used). The
subscribe flow rewrites `push-subscriptions.json` keyed by endpoint. For a budgeting app this is
the "bill due tomorrow" or "you're over budget in X" morning note, verbatim.

Rules learned:
- `workflow_dispatch` defaults to **dry-run** and the script honours an `OC_MODE` of
  `dry-run | ping | send`. Once a real subscriber exists, a manual "verification" dispatch is a
  real send; Ben got a duplicate digest that way.
- `ping` mode carries `sentAt` and the service worker writes "delivered in X s" into the
  notification body, so the latency number survives being missed. Measured 0.9 s to a locked
  iPhone in a pocket after 20 minutes; that measurement is what justified the alarm Worker.
- Notifications render outside the app on a lock screen: anything privacy-gated in the app
  must never be named in a push, regardless of the app's lock state.
- Rotating the VAPID pair invalidates every subscription; each device must re-toggle.
- Claude cannot pipe key material into secret stores (classifier). Hand Ben flat `!` commands
  (`npx wrangler secret put NAME`, `gh secret set NAME`) to run himself.

**Exact-time alarms: a Cloudflare Worker with one Durable Object per item.** Only if the app
needs a notification at an exact future moment while the PWA is suspended. There is no web
API for it: Notification Triggers was abandoned by Chrome and never existed in WebKit
(verified 2026-08-04; do not re-research without checking the date). Design that survived four
rounds of field reports:
- The client computes a **diff** (wanted alarms vs what the server was told) on a 1 s sweep
  *and* in a reactive `$effect` on the relevant fields, instead of calling out from every write
  site. Idempotent, and a new write site cannot forget it.
- The per-device ledger of "what the server might hold" is **persisted** and written
  **pessimistically before the request** (`{ at, confirmed }`), because `keepalive` requests can
  be accepted by the server after the page is gone and the ok-response never observed. A
  schedule retries until confirmed; a cancel covers any entry. Three earlier fixes made cancels
  more reliable and none could cancel an alarm the client did not know existed.
- Anything that must fire as the user leaves needs `visibilitychange` → hidden **and**
  `fetch(..., { keepalive: true })`. A polling interval is a bet suspension collects.
- Worker side: alarms are at-least-once with retries, so mark `attempted` in storage *before*
  sending to make delivery at-most-once; allow a retry only when the push service answered
  with a rejection. Durable Object gotchas that were silent bugs: the constructor signature is
  `(ctx, env)`; `storage.get(keys[])` returns a `Map`; new accounts must use
  `new_sqlite_classes` migrations. Fake the DO storage faithfully in unit tests.
- Degrade gracefully: unconfigured or down, the feature works as well as it can locally.
  Settings shows a ledger readout and a "cancel all" so the user can see and clear server state.
- Worker changes do not ship with the app bundle; Ben must `wrangler deploy`. Anything that
  needs his hands goes into a standing reminder line at the end of every status message until
  he confirms it, then gets retired.
- Native wrapping (Capacitor) was scoped and ruled out: $99/yr, kills the push→CI→autoupdate
  rhythm, and WKWebView has no service worker so it would break Web Push entirely.

### 2.11 Privacy lock pattern

Locked lists behind a PIN (salted SHA-256, synced), session unlock flag readable by the store,
and a pure `withoutLocked(rows)` helper applied at every surface that renders names. Honest
copy: this is a privacy screen, not encryption. Audit method that found leaks three times:
grep the UI directory for files that render `.name` and diff against files that import the
lock helpers; anything rendering names without a filter is a candidate. Deliberately ungated:
aggregate numbers, the locked container's own title, the user's own JSON export. A padlock
button on the main screens to unlock/relock in one tap was requested and shipped. A budgeting
app should assume money is sensitive from day one and build this in early.

### 2.12 Undo and redo

Session-only, 12 deep, every consequential action pushes an entry with a `run` closure and
optionally a `redo` closure. Rules from the redo review: serialise every run/redo through a
promise chain; a failed undo re-arms itself and surfaces a toast; redo re-applies **state,
never ceremony** (no celebrations, toasts, auto-actions); redo closures re-check preconditions
at run time (a row completed on another device since the undo is history, not a target).
Toasts are the sequencing point for undo-dependent test steps. Toasts can carry a second action
("also stop the rule") via an extra-actions slot.

### 2.13 Performance at scale

- Any view rendering one component per row goes through a **render budget** that grows on an
  intersection sentinel (600 px `rootMargin`), resets on leaving the view, and grows toward a
  deep-linked row so the row exists to scroll to. OC: 60 rows, search 50, queue 80.
- Full-dataset scans inside `$derived` compute off `$state.snapshot(rows)`. Proxy traps turned
  ~9M field reads into seconds on a phone. Precompute rank maps once, not per render.
- Search: 120 ms debounce, a pure domain function with cheap filters first, expensive graph
  work only for rows about to show, early break at the limit. A blocked-by picker did the
  expensive check inside the filter for every candidate: measured 735 ms per keystroke at 5k
  rows; a perf test asserting < 150 ms on 5,000 rows now guards it.
- Time-derived `$derived`s read a **shared ticking clock** (20 s interval + `visibilitychange`
  + a `window.__ocTickClock` test hook), never a frozen `new Date()` at render. Store
  mutations still take their own `new Date()`.
- Any collection sorted "just to print a count" is a trap; count in one pass, sort lazily only
  while the section is open.
- Measure the parts separately before optimising: twice the "slow scan" was 20 ms and the DOM
  was the whole problem.

### 2.14 Testing rig

- **Gates, in order, before every commit:** `npm run check` → `npx vitest run` →
  `npx playwright test`. Re-run from the top after the last file change; vitest does not
  typecheck what svelte-check does. Never claim "full gates" otherwise.
- Unit tests live beside their module; the domain layer is close to 100% covered. Property
  tests for merge rules (commutative, idempotent, converges), round-trip tests for
  serialisation, and simulations for anything with pacing or probability.
- e2e runs against the production build. Chromium and an iPhone 15 webkit project locally
  (real coarse-pointer coverage, but zero safe-area insets); chromium only on CI, so a
  320 px layout regression needs a local webkit run.
- Deterministic hooks the app exposes only under automation: `__ocTickClock`, a burst counter
  for celebration effects, a one-shot `localStorage` force key for delight. Delight is silent
  under `navigator.webdriver` so no overlay steals a click.
- TZ sweep: `TZ=Asia/Tokyo npx playwright test` catches wall-clock coupling.
- Flake attribution: stash → two clean full runs → unstash → fails = mine. `--repeat-each`
  under full-suite parallelism reproduces what solo runs never do. Read Playwright's
  `error-context.md` snapshot first.

---

## 3. Process that worked

### 3.1 Brainstorm → spec → phased plans

The project started with a feasibility research doc, then a single design spec with numbered
sections (vision, locked platform decisions, data model, core rules, screens, aesthetic, sync
protocol, import mapping, testing, build phases, delight, out of scope), then one plan file per
phase, each phase ending deployed with a pushed commit. Code comments cite spec sections. The
locked-decisions section ("no hosting", "PWA not native", "GitHub repo as backend") ended
several later debates in one sentence. Do this again.

### 3.2 The chunk discipline

Every unit of work: build → full gates → commit and push → verify CI green **by full SHA** →
verify the live bundle serves the change (grep a literal chunk of new text in the deployed JS)
→ update the memory file. A usage-limit cutoff then never loses more than the chunk in flight.
Field reports preempt everything queued.

Ben durably authorised pushing directly to main of both repos for OC. Do not assume that
carries over; ask once on the new project.

### 3.3 Bug reports: measure before theorising

The single most valuable habit. When a report is about a *feel* ("started tasks never come
up", "my total dropped 7 h overnight"), pull the real data (the data repo's shards via
`gh api`, a throwaway analysis script in the scratchpad) and compute the number before touching
code. Every time this was done it named the real cause and killed a plausible-but-wrong
hypothesis in one pass. When Ben re-reports something "fixed", the diagnosis was incomplete:
go read the real data, not the theory.

Circumstances in a bug report are gold ("started and completed on the Mac, phone unused" is
what acquitted two cross-device theories and exposed the real cause).

When a simulation and the field disagree three tunings running, stop tuning and diff the
simulation's assumptions against the app's actual code paths. The sim was right; the app was
never doing what the sim modelled.

When a symptom survives two real fixes, re-read the whole path assuming those fixes work; the
third cause was upstream of one and orthogonal to the other.

### 3.4 Verification honesty

- Device-only behaviours (iOS keyboard, notification prompts, Safari date shadow parts, real
  push delivery) are flagged "verify on your device", never claimed.
- Ben's standing rule after a few weeks: assume shipped work is device-verified good unless he
  reports otherwise; silence is success. Do not maintain a verify-list or ask.
- CI watcher rules: `gh run list --limit 1` at launch can grab the previous run; resolve the
  run id explicitly and confirm the conclusion by full SHA. `--commit <short-sha>` matches
  nothing. If no run registers, check `commits/<sha>/check-suites`: empty means the webhook
  event was lost, and the fix is a new push or `gh workflow run deploy.yml`, never waiting.
  Never type a SHA from memory; always `git rev-parse`.
- A machine under load fakes failures (a 27-minute gate run with timing tests red; load
  average 30 from an unrelated build). Check `uptime` before debugging timing tests and never
  commit on a contended run.

### 3.5 Agents and Ben's budget

Ben's usage limit is shared with his day job. Two investigation fleets (37 and 32 agents,
~4.9M subagent tokens) hit the session limit mid-run and their structured results were lost.
The cause was then found solo in ten minutes by reading three files. **Default to solo
investigation.** If a fleet is ever justified: at most ~4 agents, no per-finding verifier
fan-out, and agents write findings to files rather than returning them. Ben's global rules say
1 to 2 agents in flight; on this project even that was rarely worth it.

Review fleets did earn their keep twice (an anchor-stamping bug that would have silently
shifted schedules; a dead-code reset that jump-scrolled every tap), but always with adversarial
verification of each finding against the real code before acting. Reviewers are confidently
wrong often.

### 3.6 Conventions

- Commit messages via `git commit -F <file>` written with the Write tool; `git -C <path>`;
  flat single-purpose commands. Generic messages for any content that must stay a surprise.
- Comments speak to the next author in present tense, explain why, describe traps, never
  narrate history or the current PR. No temporal anchors.
- Vocabulary in UI: one verb per meaning. "Complete" finishes a thing; "done" closes a pane.
  A "done" button that completed 700 selected rows was the incident that fixed this.
- Player-facing copy: no em dashes. Content lines never start with the emoji the card already
  renders beside them.
- Icons in dense UI are drawn SVG glyphs, not emoji; emoji are fine in content and OS
  notifications. Judge a glyph by its rendered screenshot.

---

## 4. The lesson bank

Cite before re-learning. Each entry cost at least one debugging round.

### Svelte 5 and `$state`

- `$state` proxies cannot reach IndexedDB (`DataCloneError`). Snapshot at write choke points.
- The mirror mutates in place: capture before patch; match by id, not reference.
- Undo arms before the mutation.
- `autofocus` is a no-op on dynamically inserted elements; use a `focusOnMount` action.
- Svelte 5 delegates `keydown` at the app root; beat document listeners with `onkeydowncapture`.
- Input teardown blur fires into the *next* editing session; guard blur handlers with an
  "is this still mine" check.
- `{#each}` keys must be unique: repeated labels (S M T W T F S) throw `each_key_duplicate` and
  kill the render.
- Parameterised route screens render under `{#key param}` or instance reuse leaks local state.
- A `.svelte` import yielding "no default export" means the file failed to parse; a scripted
  edit hit a template line. Assert replace anchors when scripting edits.
- Moving an input into a child component orphans the parent's scoped styles; the component
  dresses itself and parents constrain layout via `.x :global(input)`.
- A `$derived` over the whole dataset that runs on every keystroke of an unrelated editor is
  the default failure mode; make expensive deriveds lazy behind the UI state that needs them.
- Never wrap a call in a swallowing `try/catch` for "garnish" (effects, celebrations) without
  running svelte-check first: a missing import became a `ReferenceError` that the catch hid for
  six debugging rounds.

### IndexedDB, Dexie, storage

- Patches in one `rw` transaction; never get-then-put.
- Await in-flight inserts before updating.
- Fixtures with unrealistic timestamps get eaten by tombstone compaction.
- A `localStorage` ledger for "what a server might hold" must persist across reloads or the
  destructive direction (cancels) never converges.

### Sync and merge

- Everything in 2.6 and 2.7. In addition:
- **A cached negative is a session-long outage.** Cache successes, retry failures (a push
  subscription miss at boot silently skipped every send for the session).
- Only the operations that need a resource should be gated on it (a cancel needs an id, not a
  subscription; the shared early-return killed cancels).
- Reverting the data repo can never fix synced state that devices re-upload; fix it with a
  merge rule plus a boot repair.
- A device that is merely open never pulls; nothing refreshes an idle tab. Any "measure the
  state at time T" job must require a pull since T.
- Read→await→write-back over shared state needs the merge rule re-applied at write time.
- Old-bundle devices strip fields they do not know; flapping self-corrects once every device
  updates, so tell the user to open the app on each device after a schema change.
- An import repair that pushed stamps decades into the future is fine *by design* (the repair
  must outrank stale copies) but it is why `editedAt` exists and why fixtures must never model
  repaired-data weirdness; audit real shards when statistics look wrong.

### Time, days, clocks

- An "app day" starts at a configurable rollover hour (04:00 in OC), and **every** day-bucketed
  thing (streaks, per-day measurements, weekly bucketing, "not today") uses the same
  `appDayKey(now, rolloverHour)`. Calendar midnight bucketing next to app-day bucketing put a
  save in the wrong week.
- Rollover timers fire on every open device; expect concurrent sweeps and make them
  idempotent (deterministic ids, skip-if-present, earliest-reading-wins).
- Windows are to-exclusive: an "all day" fixture of 00:00 to 23:59 is not due for the last 60
  seconds of every real day, and CI runs at 23:59:50 sometimes. Pin fixture clocks.
- Rolling-24-hour gates make most of each day ineligible; compare app days.
- Under `page.clock.install`, a deferred action can land inside a `fastForward`; wait for the
  UI that proves the action settled before jumping the clock.

### iOS, layout, PWA

- Every `:hover` behind `@media (hover: hover)` or touch gets sticky hover.
- `@media (pointer: coarse) { input, textarea, select { font-size: 16px !important } }`; the
  `!important` is load-bearing because Svelte scoped class styles outrank global element rules.
- Body pays back `env(safe-area-inset-*)` as padding; a sticky header uses a negative-margin
  plus padding pair to reclaim the top inset; `[data-editing-root]` gets `scroll-margin-top`
  of the inset plus the sticky bar height so reveals clear the Dynamic Island.
- `touch-action: manipulation` on body kills double-tap zoom and its 300 ms click delay.
- The iOS keyboard opens only for `focus()` inside the tap's own event turn. Add paths must be
  synchronous; tap→navigate→type needs the hidden-input bridge (`primeKeyboard` in the tap,
  `adoptKeyboard` after mount).
- A textarea that scrolls internally is unreachable on iOS (the drag pans the page); autogrow
  notes fields with no cap.
- Hide a floating action button while the keyboard is up (`visualViewport.height <
  0.75 * innerHeight`).
- A new element at the very end of the document cannot be scrolled to the top: the browser
  clamps. Render a viewport-height spacer while an editor is open.
- Date inputs have a wide intrinsic minimum; stack label and field on narrow screens. A
  valueless `input[type=date]` paints today's date dimmed on Safari;
  `input[type='date'].empty:not(:focus) { color: transparent !important }` (Blink's
  `::-webkit-datetime-edit` rule does nothing on macOS Safari; keep both). Playwright webkit is
  not real Safari for date inputs; only eyes verify.
- Any `<select>` fed user text needs `max-width`; chips need `min-width: 0` plus ellipsis.
- Any `background: none` button must set `color` explicitly: buttons do not inherit text
  colour, the UA default is black, and SVG glyphs stroke in `currentColor`. A primary button
  was invisible on a dark theme for weeks; click-based tests cannot notice invisibility, so an
  e2e asserts glyph-vs-background contrast > 3.
- Never transition `filter` (especially `drop-shadow`) on an element whose content repaints;
  iOS composites it as a black square. Draw glows as real elements behind the thing.
- Features go unfindable two ways: unrenderable, or linguistically camouflaged (phone words on
  a desktop). Both present as "the feature doesn't exist".
- Sheets that are action surfaces stay bottom-anchored; informational sheets centre on
  `(hover: hover) and (pointer: fine)`.
- Close-on-outside must decide on `pointerup` with a 12 px slop, not `pointerdown`: a finger
  landing on another row is usually starting a scroll. Blur the focused field first so the
  edit flushes before any pristine-discard check.
- Escape closes one layer per press: the deepest handler `preventDefault`s, the window-level
  fallback checks `defaultPrevented` and navigates up one route.
- Live-save architectures have no "cancel"; undo covers oops. Ben accepted this; do not add a
  save button to a pane where nothing is pending.

### Push, notifications, timers, suspension

- No web API schedules a local notification at a future time. Timers only run while the page
  is alive; catch up on `visibilitychange` visible and accept the limit or add the Worker.
- A timer that lives in a component only exists while that component is mounted; app-level
  watchers live in the root component.
- Two `showNotification` calls with the same `tag` replace the tray entry but iOS still alerts
  twice. A local notification is for someone not looking: return early when
  `document.visibilityState === 'visible'`.
- Push subscriptions bind to the VAPID public key; expose an override in Settings so
  self-hosters can use their own pair.
- The Worker keys Durable Objects by item id so a moved appointment overwrites its own alarm.

### Unit tests

- Vitest reports "N passed" even when whole suites fail to load; read the "Test Files" line.
- Pair every "does not happen" assertion with a "does happen" one; the first can pass because
  the harness never satisfied a guard (`'Notification' in window`) in either case.
- Simulations must grant/consume the same way the real presenter does or an always-eligible
  guaranteed item short-circuits every roll.
- Timing-sensitive perf tests need a quiet machine; check `uptime` first.
- Fake runtime APIs faithfully (the DO storage `Map`), because the bugs were in the runtime
  contract, not the logic.

### e2e (Playwright)

- `locator.count()`, `getAttribute()`, `allTextContents()` do not auto-wait; `waitFor()` the
  element then read. Every unwaited read is a scheduling bet CI eventually collects.
- Settle-then-assert for negatives ("did not navigate", "still shows X", "does not move");
  `expect.poll` until true cannot prove a negative, its first sample passes before the thing
  happens. Bought three times.
- One-sided position assertions (`y < 150`) are satisfied by elements scrolled off the top;
  pin both bounds.
- `toBeVisible` counts offscreen elements as visible; assert `boundingBox`. `mouse.wheel`
  returns before the scroll lands; poll `scrollY`.
- `toContainText` can pass against pre-rerender DOM; assert state marks (classes), not
  leftover text. Assert input values with `toHaveValue`, not text content.
- `page.goto('#/x')` does not reload; IndexedDB fixtures need an explicit `reload()`. But
  `page.goto('./')` from a hash route full-reloads on webkit and resets in-memory session
  state (an unlock died far from the cause); `./#/` does not.
- `page.clock.setFixedTime` after boot needs the clock-poke hook; no reload after mocking or
  webkit loses the mock. `test.skip(cond, msg)` inside the body, not `test.skip(fn)`.
- Drag flows: dispatch synthetic `PointerEvent`s in-page with `bubbles: true` (document
  listeners never see events dispatched on `window`); real mouse starves on CI. Check the
  product's `pointerType`/target guards first: `page.mouse` and a finger take different code
  paths, and driving the wrong one passes while proving nothing. Drag downward when the row
  sits near the top (an off-screen target delivers no movement and reads as a tap). Assert
  on a drag ghost *before* dispatching pointerup.
- Strict-mode: `getByText('x')` will also match a preview/ghost clone; scope the locator.
- Random draws in fixtures: capture the drawn name, derive the rest.
- Undo toasts contain row names; `getByText` needs `{ exact: true }`. After any batch action,
  wait for the toast before undoing.
- A focused field owns Ctrl+Z; blur before testing global undo.
- Reveal/scroll assertions read after the transition (t=0 reads 0 opacity).
- Probe before believing: a throwaway spec printing `isVisible`/`count`/`activeElement` beats
  two rounds of theory. A flake fix must be re-run, not reasoned about.
- The preview server serves `dist/`; rebuild after source edits mid-session or the run tests
  stale code (hit three times).
- Never restore a teeth experiment with `git checkout --` on a file carrying other uncommitted
  work. Teeth surgery uses exact-string replace with an assert, grep-verifies the file between
  steps, and a run whose build failed proves nothing.

### CI, gates, deploy

- Everything in 3.4. Also: `cancel-in-progress` means a run superseded by the next push shows
  "cancelled", not "failed"; report it as such.
- GitHub outages can drop webhooks for hours while pushes succeed; recovery is
  `workflow_dispatch`, never waiting.
- Template literals never contain the full spoken phrase; grep the live bundle for literal
  chunks. Multi-line constants are missed by single-line greps.
- Scratchpad files are gone by the next reboot; anything the user must copy (a minted secret)
  is handed over in the message, not left in a file.

### UX patterns that stuck

- **Armed confirm** for destructive or wide-blast actions: first tap arms ("delete 12?"),
  second applies, any other interaction disarms, and all armed states reset when the selection
  drops. Applied to bulk delete, bulk complete, and a suspicious bulk value.
- **A field that parses-and-saves on input keeps a local draft while focused** and adopts
  outside values only when blurred, or it fights the hand ("45m" became "0.75in").
- **Unit guards** for bare numbers where the unit is ambiguous (a bare 30 meant minutes, was
  saved as hours): a one-tap corrector, never a block.
- Commit on blur *and* Enter; phone keyboards blur, they do not Enter.
- Deep links open the thing expanded and scrolled into view, growing any render budget to
  reach it; a reveal re-asserts once after freshly budgeted rows finish their intro animation.
- Follow-the-row: when an edit moves a row to another container, navigate to it rather than
  letting it swoop away.
- Pickers render in the user's own home-screen order with group headers, archived and generated
  containers hidden, current value kept as a fallback option.
- Sunday-first weekdays everywhere (pickers, summaries, bucketing) once chosen; the summary
  text drifted from the picker until a review caught it.
- A "can't see it" report about a control usually means it is black-on-black or phrased for the
  wrong platform.
- Bulk edit bars become small editors: selection persists across field edits, disappears on
  actions that remove rows, hides the floating add button while up.
- Rule-bound rows nudge when they diverge from their rule ("the rule still says X") with a
  one-tap adopt; names and notes never nudge.

### Content and delight (generic; content itself is never described)

- A weighted, governed, cooldown-aware picker over a registry, with per-event daily caps and a
  global quiet-time governor. Earned milestones are `guaranteed` (never a dice roll).
- Repeats were arithmetic, not inventory: independent picks over 150 items collide fast. Deal
  from a shuffled bag per pool (device-local indices re-validated against pool length).
- Any sole-voice event needs a cooldown or cap or it becomes the register of a heavy day.
- Ambient triggers on navigation annoy; Ben asked for them off. Celebrate finishing, never
  moving around.
- Story-like sequences need explicit acknowledgement plus a "pending" record; advancing on
  presentation lost beats when the app was backgrounded, advancing only on close stalled
  forever when the user tapped away. Both were real.
- Pacing is tuned with a simulation over the real registry and governor, pinned by cadence
  tests (ranges, not exact counts). Weights are context functions when a fixed weight would
  spam early users or starve patient ones.
- Registry tests: uniqueness, length caps (≤ 200 chars), minimum pool sizes, "every defined
  unlock is earnable", "every effect name is drawn by something", "no entry triggers on
  navigation". They catch real mistakes every content pass.
- Spoiler discipline: content never described in chat, commits, docs, or memory. Generic commit
  messages. Recovering content the user was owed and lost is not a spoiler.

### Process scars

- A false mechanism theory nearly landed as a test comment; probes on possibly-stale binaries
  are not evidence.
- Repeated index-arithmetic surgery on one file produced contradictory teeth runs; cap at two
  passes per file, then redesign.
- The import mapping discards an interval the source supports; Ben declined the fix because a
  re-import would clobber hand edits. **Never re-run an import over hand-edited data without a
  fresh ask**, and design imports so re-runs are safe (preserve callbacks for app-only fields,
  prior completion beats incoming open, floor-stamp sources with no modification dates at 1
  so they can never outrank a local edit).
- Sources with dual epochs (Cocoa vs Unix) need per-value thresholds; an import once landed 31
  years in the future.

---

## 5. Translating to a budgeting app

These are recommendations from the OC experience, not battle-tested lessons. Ben's product doc
decides the shape; this is how the recipe maps.

- **Money is integer minor units** (cents) in every row, never floats. Format at the edge.
- **Transactions are rows; balances are derived.** OC's stored aggregate (a daily backlog
  measurement) was the single biggest source of "the number is wrong" reports until its merge
  and recording rules were nailed down. Derive balances from rows on read, snapshot-first for
  performance, and only introduce a stored per-day measurement if reconstruction is truly
  impossible; if you do, merge it earliest-reading-wins and gate recording on a fresh pull.
- **Accounts and categories are the "lists and tags"**: small, in `active.json`, with the
  lock pattern available per account from day one.
- **Recurring bills are recurrence templates** with deterministic spawn ids across devices and
  a self-healing sweep for dormant templates that heals to the next rollover, not to now.
- **Bank CSV/OFX import is the Things import**: idempotent upserts keyed by a stable source id,
  preserve callbacks for app-only fields, floor-stamp imported rows so hand edits always win,
  reconcile classifications on every re-import, and never auto-run it over hand-edited data.
- **History sharding by month** may fit better than by year plus hash: a month's transactions
  are what a user edits together. Measure the median edit payload before deciding.
- **The morning digest becomes "due in 2 days" / "over budget"** with the same dry-run-default
  workflow. The alarm Worker is probably unnecessary; skip it unless an exact-time need appears.
- **Undo for every delete and every bulk action** from the first commit; money rows are the
  700-task incident waiting to happen.
- **Unit guards on amounts**: a bare "1500" typed into a dollars field is a candidate for
  "did you mean $15.00?" only if the field is ambiguous; otherwise commit silently.
- **Statistics screens** are the surfaces Ben enjoys most and reports on most; build the
  breakdown that itemises a headline (sections that sum exactly to the delta, with an "other
  adjustments" residual) alongside the headline itself, and make the small wins minute-accurate
  rather than rounded to nothing.

---

## 6. Day-one checklist

### 6.1 Repos and accounts (Ben)

- [ ] Create the public app repo and enable Pages via Actions.
- [ ] Create the private data repo (`<app>-data`), seed `meta.json` with `{ "schema": 1 }`.
- [ ] Mint a fine-grained PAT: Contents read/write, that repo only. Write the PAT setup doc.
- [ ] Decide whether direct pushes to main are authorised for this project.

### 6.2 Scaffold (Claude)

- [ ] Vite + Svelte 5 + TS 5 + vite-plugin-pwa; copy `vite.config.ts`, `playwright.config.ts`,
      `tsconfig.json`, `src/tests/setup.ts`, `.github/workflows/deploy.yml` from OC and change
      the base path and names.
- [ ] `src/app.css` with the iOS rules from section 4 (16 px inputs, hover gating, safe-area,
      touch-action, date input floor).
- [ ] `domain/types.ts` with the row convention; `storage/db.ts`; `storage/repo.ts` with
      `nextStamp`, transactional `patchRow`, `replaceAll` re-applying `supersedes`.
- [ ] `sync/` copied and trimmed: client, files (sharded from the start, schema gate), merge
      (the four-step `pick`, canonical comparison), engine (cache, backoff, conflict path).
- [ ] The store with a mirror, `init`, and sync wiring; a Settings screen with the token flow
      and an honest privacy paragraph.
- [ ] Tests before features: merge properties, files round-trip with every field populated,
      schema-too-new failure, tombstone compaction with realistic timestamps, engine conflict
      retry, 404 disambiguation, > 1 MB blob fallback.
- [ ] e2e smoke that proves the theme CSS loaded and the base path serves; a sync spec against
      a route-stubbed API.
- [ ] A live client self-test gated on an env token that writes only under `_selftest/`.
- [ ] Memory file for the project and the first entry in it: the locked decisions.

### 6.3 Seed for the new repo's `CLAUDE.md`

```
# <App> working notes (project layer; Ben's global CLAUDE.md applies on top)
- Read docs/PLAYBOOK.md once; cite its lesson bank before re-learning anything.
- Gates before every commit, in order: npm run check → npx vitest run → npx playwright test.
  Re-run from the top after the last edit. Rebuild before e2e after source edits.
- Fixes ship with teeth: the test fails without the fix. Pair negatives with positives.
- Verify CI by full SHA and the live bundle by grepping a literal chunk of the change.
- Measure real data before changing code for any "feel" report.
- Solo investigation by default; agents cap at ~4 with findings written to files.
- Rows: nextStamp = max(now, current+1); editedAt = wall clock; tombstones, never hard deletes;
  $state.snapshot before any IndexedDB write; patches inside one rw transaction.
- Sync: private data repo via Contents API; sharded files; schema gate; sameAs enumerates
  every field (add new snapshot fields there or they never push).
- App day rolls at the configured hour; every day-bucketed feature uses appDayKey.
- Money is integer cents. Balances derive from rows.
- Anything that must fire as the user leaves: visibilitychange hidden + fetch keepalive.
- Notifications never name anything privacy-locked. Manual dispatch of a push workflow
  defaults to dry-run.
- Vocabulary: "complete"/"confirm" finishes, "done" closes. Armed confirm for wide actions.
- UI icons are drawn SVG glyphs; no em dashes in user-facing copy.
- Field reports preempt queued work. Silence after a ship means it worked.
```

---

## 7. What this document leaves out

- Product design for the budgeting app: Ben's Claude Chat document.
- OC's own domain (the randomizer, priority escalation, rituals, the story): irrelevant here
  and partly spoiler-protected.
- The exact content of any delight pool. If the budgeting app grows a delight layer, reuse the
  engine shape from section 4 and write fresh content; never copy OC's.
- Things-specific import decoding. The reusable part is the import discipline in section 4.

If something here reads as an instruction rather than a lesson, it is because it was learned
by getting it wrong first. Where the new project finds a better way, update this file.
