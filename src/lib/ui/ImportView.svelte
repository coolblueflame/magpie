<!-- Import (spec §5, §6): statements, CSVs through profiles, the shared sheet, and the one-time YNAB cutover. -->
<script lang="ts">
  import { nanoid } from 'nanoid';
  import { app } from '../state/app.svelte';
  import { undoStack } from '../state/undo.svelte';
  import { toast, undoToast } from './toast.svelte';
  import { navigate } from './router.svelte';
  import { csvObjects, parseCsv } from '../domain/csv';
  import { candidatesFromCsv, DATE_FORMATS, detectDateFormat, headerSignature } from '../domain/csvImport';
  import { foldEdits, planImport, type ImportCandidate, type ImportPlan } from '../domain/importPlan';
  import { decodeOfx, isOfx, parseOfx, type OfxStatement } from '../domain/ofx';
  import { isSheetHeader, parseSheet, planClaims, planSheet, type SheetPlan } from '../domain/sheet';
  import { accountBalances } from '../domain/ledger';
  import { formatMoney } from '../domain/money';
  import { monthLabel } from '../domain/month';
  import {
    buildYnabImport, defaultCutoverMonth, inferAccounts, isYnabPlan, isYnabRegister, readYnabPlan, readYnabRegister,
    type InferredAccount, type YnabAccountChoice, type YnabImport, type YnabPlanRow, type YnabRegisterRow,
  } from '../domain/ynab';
  import type { AccountKind, CsvProfile, Transaction } from '../domain/types';

  const KINDS: AccountKind[] = ['chequing', 'savings', 'credit', 'cash', 'person', 'loan', 'investment', 'other'];

  // ── statements, CSVs, the sheet ────────────────────────────────────────
  type Entry =
    | { name: string; kind: 'ofx'; statement: OfxStatement }
    | { name: string; kind: 'csv'; header: string[]; rows: Record<string, string>[] }
    | { name: string; kind: 'sheet'; rows: string[][]; header: string[] }
    | { name: string; kind: 'unknown'; reason: string };
  let queue = $state.raw<Entry[]>([]);
  let accountId = $state('');
  let error = $state('');
  let busy = $state(false);
  const current = $derived(queue[0]);
  const openAccounts = $derived(app.state.accounts.filter((a) => !a.closed).sort((a, b) => a.sortOrder - b.sortOrder));
  const personAccounts = $derived(app.state.accounts.filter((a) => a.kind === 'person' && !a.closed));

  async function onFiles(e: Event) {
    // currentTarget is only valid synchronously; the value reset below runs after awaits.
    const input = e.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    error = '';
    const entries: Entry[] = [];
    for (const f of files) {
      const bytes = await f.arrayBuffer();
      const asText = new TextDecoder('utf-8').decode(bytes);
      if (isOfx(asText)) { entries.push({ name: f.name, kind: 'ofx', statement: parseOfx(decodeOfx(bytes)) }); continue; }
      const header = asText.split(/\r?\n/, 1)[0] ?? '';
      if (isYnabRegister(header) || isYnabPlan(header)) { entries.push({ name: f.name, kind: 'unknown', reason: 'That is a YNAB export; use the section below.' }); continue; }
      const rows = parseCsv(asText);
      if (rows[0] && isSheetHeader(rows[0])) { entries.push({ name: f.name, kind: 'sheet', rows, header: rows[0] }); continue; }
      if (rows[0] && rows.length > 1) { entries.push({ name: f.name, kind: 'csv', header: rows[0], rows: csvObjects(asText) }); continue; }
      entries.push({ name: f.name, kind: 'unknown', reason: 'Not a statement, sheet or CSV that Magpie can read.' });
    }
    queue = [...queue, ...entries];
    input.value = '';   // so choosing the same file again fires change
    pickAccount();
  }
  function pickAccount() {
    const c = queue[0];
    if (!c) return;
    if (c.kind === 'ofx' && c.statement.accountRef) accountId = app.state.accounts.find((a) => a.externalRef === c.statement.accountRef)?.id ?? '';
    else if (c.kind === 'csv') accountId = profileFor(c)?.accountId ?? '';
    else accountId = '';
    mapping = null;
  }
  function next() { queue = queue.slice(1); pickAccount(); }

  // CSV profiles: an unknown header walks the mapping form once.
  const profileFor = (c: Entry & { kind: 'csv' }) => app.state.profiles.find((p) => p.headerSignature === headerSignature(c.header));
  let mapping = $state<null | { name: string; date: string; payee: string; memo: string; id: string; amountMode: CsvProfile['amountMode']; amount: string; outflow: string; inflow: string; dateFormat: string }>(null);
  function startMapping(c: Entry & { kind: 'csv' }) {
    const lower = c.header.map((h) => h.toLowerCase());
    const find = (...words: string[]) => c.header[lower.findIndex((h) => words.some((w) => h.includes(w)))] ?? '';
    const date = find('date', 'posted');
    mapping = {
      name: c.name.replace(/\.csv$/i, ''), date, payee: find('description', 'payee', 'details', 'name', 'merchant'), memo: find('memo', 'note'), id: find('reference', 'ref', ' id', 'transaction id'),
      amountMode: find('debit', 'withdraw', 'outflow') ? 'outflow-inflow' : 'signed', amount: find('amount'), outflow: find('debit', 'withdraw', 'outflow'), inflow: find('credit', 'deposit', 'inflow'),
      dateFormat: detectDateFormat(c.rows.slice(0, 20).map((r) => r[date] ?? '')) ?? 'YYYY-MM-DD',
    };
  }
  const profileDraft = $derived.by((): CsvProfile | null => {
    const c = current;
    if (!c || c.kind !== 'csv') return null;
    const saved = profileFor(c);
    if (saved && !mapping) return saved;
    if (!mapping) return null;
    return {
      id: saved?.id ?? 'draft', updatedAt: 0, deleted: false, headerSignature: headerSignature(c.header), name: mapping.name,
      mapping: { date: mapping.date, payee: mapping.payee, ...(mapping.memo ? { memo: mapping.memo } : {}), ...(mapping.id ? { id: mapping.id } : {}),
        ...(mapping.amountMode === 'outflow-inflow' ? { outflow: mapping.outflow, inflow: mapping.inflow } : { amount: mapping.amount }) },
      dateFormat: mapping.dateFormat, amountMode: mapping.amountMode,
    };
  });

  // The plan for the current statement or CSV against the chosen account.
  const candidates = $derived.by((): { list: ImportCandidate[]; error: string } => {
    const c = current;
    try {
      if (c?.kind === 'ofx') return { list: c.statement.transactions.map((t) => ({ externalId: `fitid:${t.fitid}`, date: t.date, amount: t.amount, descriptor: t.descriptor, memo: t.name && t.memo ? t.memo : '', source: { kind: 'ofx', batchId: `ofx-${c.name}` } })), error: '' };
      if (c?.kind === 'csv' && profileDraft) return { list: candidatesFromCsv(c.rows, profileDraft, `csv-${c.name}`), error: '' };
    } catch (e) { return { list: [], error: (e as Error).message }; }
    return { list: [], error: '' };
  });
  // Planned once per account or mapping choice, never while a commit is applying: the plan
  // must be applied against the state it was computed from, and re-planning on every
  // write of the commit would snapshot the whole dataset dozens of times.
  let plan = $state.raw<ImportPlan | null>(null);
  let projected = $state<number | null>(null);
  $effect(() => {
    const list = candidates.list;
    const acct = accountId;
    if (busy) return;
    if (!acct || !list.length) { plan = null; projected = null; return; }
    try {
      const p = planImport(list, acct, app.importState());
      const working = accountBalances(app.accountsSnap, app.transactionsSnap).get(acct)?.working ?? 0;
      plan = p;
      projected = working + p.created.reduce((s, c) => s + c.amount, 0);
    } catch { plan = null; projected = null; }
  });
  const resolution = (c: ImportCandidate) => plan?.skipped.includes(c) ? 'skip' : plan?.matched.some((m) => m.candidate === c) ? 'match' : 'new';

  async function commitPlan() {
    const c = current;
    if (!plan || !c) return;
    busy = true;
    error = '';
    try {
      if (c.kind === 'csv' && profileDraft) {
        const { id, updatedAt, deleted, ...rest } = profileDraft;
        void updatedAt; void deleted;
        await app.saveProfile({ ...rest, accountId, ...(id !== 'draft' ? { id } : {}) });
      }
      const n = plan.created.length + plan.matched.length;
      // New bank rows may be what open claims were waiting for; the claim splits go into the
      // same undo entry, planned against the rows this import is about to create.
      let edits = plan.edits;
      let applied = 0;
      const person = app.state.settings.sheet?.personAccountId;
      const open = app.state.claims.filter((k) => k.status === 'open');
      if (person && open.length) {
        const s = app.importState();
        const now = Date.now();
        const createdRows = plan.edits
          .filter((e): e is typeof e & { create: Record<string, unknown> } => 'create' in e && e.table === 'transactions')
          .map((e) => ({ ...(e.create as Omit<Transaction, 'id' | 'updatedAt' | 'deleted'>), id: e.id, updatedAt: now, deleted: false }) as Transaction);
        const names = new Map(s.payees.map((p) => [p.id, p.name]));
        for (const p of plan.payeesToCreate) names.set(p.id, p.name);
        const cp = planClaims(open, [...s.transactions, ...createdRows], s.accountsById, person, (id) => (id ? names.get(id) ?? '' : ''), app.state.settings.cutoverMonth);
        edits = foldEdits([...plan.edits, ...cp.edits]);
        applied = cp.applied.length;
      }
      await app.applyEdits(edits, `import ${n} rows`);
      if (c.kind === 'ofx' && c.statement.accountRef) await app.rememberAccountRef(accountId, c.statement.accountRef);
      undoToast(applied ? `${plan.summary}; ${applied} shared claims applied` : plan.summary);
      plan = null;
      next();
    } catch (e) { error = (e as Error).message; }
    finally { busy = false; }
  }

  // The shared sheet: two answers the first time, then rows become claims or person-account rows.
  let sheetMineFirst = $state(true);
  let sheetPerson = $state('');
  const sheetSettings = $derived(app.state.settings.sheet);
  const sheetPlan = $derived.by((): (SheetPlan & { claimsNow: number }) | null => {
    const c = current;
    if (c?.kind !== 'sheet' || !sheetSettings) return null;
    try {
      const rows = parseSheet(c.rows, sheetSettings.mineFirst);
      const s = app.importState();
      const cutover = app.state.settings.cutoverMonth;
      const p = planSheet(rows, sheetSettings.personAccountId, s, Date.now(), nanoid, cutover);
      const cp = planClaims([...s.claims.filter((k) => k.status === 'open'), ...p.claims], s.transactions, s.accountsById, sheetSettings.personAccountId, (id) => s.payees.find((x) => x.id === id)?.name ?? '', cutover);
      // Claims created and applied in the same import fold into one create, one undo entry.
      return { ...p, edits: foldEdits([...p.edits, ...cp.edits]), claimsNow: cp.applied.length };
    } catch { return null; }
  });
  async function saveSheetSettings() {
    if (!sheetPerson) return;
    await app.updateSettings({ sheet: { mineFirst: sheetMineFirst, personAccountId: sheetPerson } });
  }
  async function commitSheet() {
    const c = current;
    if (c?.kind !== 'sheet' || !sheetPlan || !sheetSettings) return;
    busy = true;
    error = '';
    try {
      const rows = sheetPlan.claims.length + sheetPlan.partnerPaid.length;
      if (sheetPlan.edits.length) await app.applyEdits(sheetPlan.edits, `import ${rows} sheet rows`);
      undoToast(`Sheet: ${sheetPlan.claims.length} claims, ${sheetPlan.partnerPaid.length} partner-paid rows, ${sheetPlan.claimsNow} applied now`);
      next();
    } catch (e) { error = (e as Error).message; }
    finally { busy = false; }
  }

  // ── YNAB (one-time cutover) ────────────────────────────────────────────
  let register = $state.raw<YnabRegisterRow[] | null>(null);
  let planRows = $state.raw<YnabPlanRow[] | null>(null);
  let build = $state.raw<YnabImport | null>(null);
  let choices = $state<(InferredAccount & { person: boolean })[]>([]);
  let ynabError = $state('');
  let cutoverChoice = $state('');
  const planMonths = $derived(planRows ? [...new Set(planRows.map((r) => r.month))].sort().reverse() : []);
  const isEmpty = $derived(!app.state.accounts.length && !app.state.categories.length && !app.state.transactions.length);

  async function onYnabFile(e: Event, which: 'register' | 'plan') {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    ynabError = '';
    build = null;
    const text = await file.text();
    const header = text.split(/\r?\n/, 1)[0] ?? '';
    try {
      if (which === 'register') {
        if (!isYnabRegister(header)) throw new Error('That is not a YNAB Register export.');
        register = readYnabRegister(text);
        choices = inferAccounts(register).map((a) => ({ ...a, person: false }));
      } else {
        if (!isYnabPlan(header)) throw new Error('That is not a YNAB Plan export.');
        planRows = readYnabPlan(text);
      }
      if (register && planRows) cutoverChoice = defaultCutoverMonth(register, planRows);
    } catch (err) { ynabError = (err as Error).message; }
  }
  function setPerson(i: number) {
    choices = choices.map((c, k) => (k === i
      ? { ...c, person: true, kind: 'person' as const, onBudget: true }
      : { ...c, person: false, kind: c.kind === 'person' ? 'other' as const : c.kind }));
  }
  function analyse() {
    if (!register || !planRows) return;
    ynabError = '';
    try {
      const accounts: Record<string, YnabAccountChoice> = Object.fromEntries(choices.map((c) => [c.name, { kind: c.kind, onBudget: c.onBudget, person: c.person }]));
      build = buildYnabImport(register, planRows, { accounts, now: Date.now(), ...(cutoverChoice ? { cutoverMonth: cutoverChoice } : {}) });
    } catch (err) { ynabError = (err as Error).message; }
  }
  async function doYnabImport() {
    if (!build) return;
    busy = true;
    try { await app.importYnab(build); navigate({ name: 'budget' }); }
    catch (err) { ynabError = (err as Error).message; }
    finally { busy = false; }
  }
</script>

<section class="import" class:empty={isEmpty}>
  <div class="statements">
  <h2>Import</h2>
  <p class="dim">Statement files (QFX/OFX), CSV exports, or the shared expense sheet. Several at once is fine; they queue.</p>
  <p><input type="file" multiple data-testid="file-any" onchange={(e) => void onFiles(e)} /></p>
  {#if error}<p class="error" data-testid="import-error">{error}</p>{/if}
  {#if queue.length > 1}<p class="dim" data-testid="queue-count">{queue.length - 1} more file{queue.length > 2 ? 's' : ''} queued</p>{/if}

  {#if current}
    <div class="panel" data-testid="panel">
      <h3>{current.name} <span class="dim">· {current.kind === 'ofx' ? 'statement' : current.kind}</span></h3>
      {#if current.kind === 'unknown'}
        <p class="error">{current.reason}</p>
        <p><button data-testid="skip-file" onclick={next}>Skip</button></p>
      {:else if current.kind === 'sheet'}
        {#if !sheetSettings}
          <p>First time with the sheet. Two answers, remembered from now on.</p>
          <p>Which column is you?
            <label><input type="radio" name="mine" data-testid="sheet-mine-first" checked={sheetMineFirst} onchange={() => (sheetMineFirst = true)} /> {current.header[isSheetHeader(current.header)!.paid[0]]}</label>
            <label><input type="radio" name="mine" data-testid="sheet-mine-second" checked={!sheetMineFirst} onchange={() => (sheetMineFirst = false)} /> {current.header[isSheetHeader(current.header)!.paid[1]]}</label>
          </p>
          <p>Which account is the other person?
            <select data-testid="sheet-person" bind:value={sheetPerson}>
              <option value="">Choose…</option>
              {#each personAccounts as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
            </select>
            {#if !personAccounts.length}<span class="error">No person account yet; add one under Accounts (kind: person).</span>{/if}
          </p>
          <p><button data-testid="sheet-save-settings" disabled={!sheetPerson} onclick={() => void saveSheetSettings()}>Continue</button></p>
        {:else if sheetPlan}
          <p data-testid="sheet-summary">
            {sheetPlan.claims.length} rows you paid become claims ({sheetPlan.claimsNow} match a bank row already);
            {sheetPlan.partnerPaid.length} rows the other person paid become transactions in {app.state.accounts.find((a) => a.id === sheetSettings.personAccountId)?.name};
            {sheetPlan.skipped} already imported.
          </p>
          <p><button data-testid="commit-sheet" class="primary" disabled={busy || (!sheetPlan.edits.length && !sheetPlan.claimsNow)} onclick={() => void commitSheet()}>Import sheet</button> <button onclick={next}>Skip</button></p>
        {:else}
          <p class="error">Could not read the sheet rows.</p><p><button onclick={next}>Skip</button></p>
        {/if}
      {:else}
        {#if current.kind === 'csv' && !profileFor(current) && !mapping}
          <p>New CSV layout. Tell Magpie which column is which; it is remembered for files with this header.</p>
          <p><button data-testid="start-mapping" onclick={() => startMapping(current as Entry & { kind: 'csv' })}>Map columns</button></p>
        {/if}
        {#if current.kind === 'csv' && mapping}
          {@const header = current.header}
          <div class="mapping">
            <label>Profile name <input data-testid="map-name" bind:value={mapping.name} /></label>
            <label>Date column <select data-testid="map-date" bind:value={mapping.date}>{#each header as h}<option value={h}>{h}</option>{/each}</select></label>
            <label>Date format <select data-testid="map-dateformat" bind:value={mapping.dateFormat}>{#each DATE_FORMATS as f}<option value={f}>{f}</option>{/each}</select></label>
            <label>Payee column <select data-testid="map-payee" bind:value={mapping.payee}>{#each header as h}<option value={h}>{h}</option>{/each}</select></label>
            <label>Memo column <select data-testid="map-memo" bind:value={mapping.memo}><option value="">none</option>{#each header as h}<option value={h}>{h}</option>{/each}</select></label>
            <label>Id column <select data-testid="map-id" bind:value={mapping.id}><option value="">none</option>{#each header as h}<option value={h}>{h}</option>{/each}</select></label>
            <label>Amounts
              <select data-testid="map-mode" bind:value={mapping.amountMode}>
                <option value="signed">one signed column</option>
                <option value="negate">one column, positive means spending</option>
                <option value="outflow-inflow">outflow and inflow columns</option>
              </select>
            </label>
            {#if mapping.amountMode === 'outflow-inflow'}
              <label>Outflow column <select data-testid="map-outflow" bind:value={mapping.outflow}>{#each header as h}<option value={h}>{h}</option>{/each}</select></label>
              <label>Inflow column <select data-testid="map-inflow" bind:value={mapping.inflow}>{#each header as h}<option value={h}>{h}</option>{/each}</select></label>
            {:else}
              <label>Amount column <select data-testid="map-amount" bind:value={mapping.amount}>{#each header as h}<option value={h}>{h}</option>{/each}</select></label>
            {/if}
          </div>
        {/if}
        {#if candidates.error}<p class="error" data-testid="candidates-error">{candidates.error}</p>{/if}
        {#if candidates.list.length}
          <p>
            <label>Into account
              <select data-testid="imp-account" bind:value={accountId}>
                <option value="">Choose…</option>
                {#each openAccounts as a (a.id)}<option value={a.id}>{a.name}</option>{/each}
              </select>
            </label>
            {#if current.kind === 'ofx' && current.statement.accountType}<span class="dim">file says {current.statement.accountType.toLowerCase()}</span>{/if}
          </p>
          {#if plan}
            <p data-testid="imp-summary" class="ok">{plan.summary}</p>
            {#if current.kind === 'ofx' && current.statement.ledgerBalance !== undefined && projected !== null}
              <p data-testid="imp-ledger" class={projected === current.statement.ledgerBalance ? 'ok' : 'warn'}>
                The file's balance is {formatMoney(current.statement.ledgerBalance)}; after import Magpie will show {formatMoney(projected)}.
                {#if projected !== current.statement.ledgerBalance}A difference means rows are missing on one side or the file's balance is stale; the import is still safe.{/if}
              </p>
            {/if}
            <table>
              <thead><tr><th>Date</th><th>Description</th><th class="money">Amount</th><th>Result</th></tr></thead>
              <tbody>
                {#each candidates.list as c (c.externalId)}
                  <tr data-testid={`cand-${c.externalId}`} class={resolution(c)}>
                    <td class="date">{c.date}</td><td>{c.descriptor}{#if c.memo} <span class="dim">· {c.memo}</span>{/if}</td>
                    <td class={`money ${c.amount < 0 ? 'neg' : 'pos'}`}>{formatMoney(c.amount)}</td><td class="res">{resolution(c)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
            <p><button data-testid="commit-import" class="primary" disabled={busy} onclick={() => void commitPlan()}>Import</button> <button data-testid="skip-file" onclick={next}>Skip this file</button></p>
          {/if}
        {/if}
      {/if}
    </div>
  {/if}

  </div>
  <div class="ynab">
  <h2 class="ynab">{isEmpty ? 'Start here: import your YNAB budget' : 'YNAB export (one-time cutover)'}</h2>
  <p class="dim">In YNAB, open the budget menu and choose Export budget; unzip it and pick the two files below.</p>
  <div class="files">
    <label>Register CSV <input type="file" accept=".csv,text/csv" data-testid="file-register" onchange={(e) => void onYnabFile(e, 'register')} /></label>
    <label>Plan CSV <input type="file" accept=".csv,text/csv" data-testid="file-plan" onchange={(e) => void onYnabFile(e, 'plan')} /></label>
  </div>
  {#if ynabError}<p class="error" data-testid="ynab-error">{ynabError}</p>{/if}
  {#if register && planRows}
    <h3>Accounts</h3>
    <p class="dim">Kind and on-budget were guessed from the rows; YNAB never categorises tracking accounts. Pick the partner's account if there is one.</p>
    <table>
      <thead><tr><th>Account</th><th>Rows</th><th>Kind</th><th>On budget</th><th>Partner</th></tr></thead>
      <tbody>
        {#each choices as c, i (c.name)}
          <tr data-testid={`account-row-${i}`}>
            <td>{c.name}</td><td class="money">{c.rows}</td>
            <td><select data-testid={`kind-${i}`} bind:value={c.kind} disabled={c.person}>{#each KINDS as k}<option value={k}>{k}</option>{/each}</select></td>
            <td><input type="checkbox" data-testid={`onbudget-${i}`} bind:checked={c.onBudget} disabled={c.person} /></td>
            <td><input type="radio" name="person" data-testid={`person-${i}`} checked={c.person} onchange={() => setPerson(i)} /></td>
          </tr>
        {/each}
      </tbody>
    </table>
    <p>
      <label>Cutover month (Magpie's rules take over here; earlier months stay as YNAB had them)
        <select data-testid="cutover-month" bind:value={cutoverChoice} onchange={() => (build = null)}>
          {#each planMonths.slice(0, 24) as m (m)}<option value={m}>{monthLabel(m)}</option>{/each}
        </select>
      </label>
    </p>
    <p><button data-testid="analyse" onclick={analyse}>Analyse</button></p>
  {/if}
  {#if build}
    {@const r = build.report}
    <h3>What would be imported</h3>
    <p data-testid="report-counts">
      {r.counts.accounts} accounts, {r.counts.categories} categories in {r.counts.groups} groups, {r.counts.payees} payees,
      {r.counts.transactions} transactions ({r.counts.splits} splits, {r.counts.transfers} transfers, {r.counts.newRows} still to categorise),
      {r.counts.assignments} assignments, {r.counts.history} months of history. Cutover month: {monthLabel(build.cutoverMonth)}.
    </p>
    <p data-testid="report-mismatches" class={r.cutoverMismatches || r.activityMismatches ? 'error' : 'ok'}>
      {r.cutoverMismatches} cutover mismatches, {r.activityMismatches} activity mismatches
    </p>
    {#if r.creditCardFolded > 0}
      <p data-testid="report-cc">Ready to Assign is {formatMoney(r.creditCardFolded)} higher than in YNAB: money YNAB kept aside for card payments is simply money here.</p>
    {:else if r.creditCardFolded < 0}
      <p data-testid="report-cc">Ready to Assign is {formatMoney(-r.creditCardFolded)} lower than in YNAB: card balances YNAB had not covered with payment money count as real debt here.</p>
    {/if}
    <h4>{monthLabel(build.cutoverMonth)} available, YNAB vs Magpie</h4>
    <table>
      <thead><tr><th>Category</th><th class="money">YNAB</th><th class="money">Magpie</th></tr></thead>
      <tbody>
        {#each r.cutover as c (c.categoryId)}
          <tr data-testid={`verify-${c.categoryId}`} class:mismatch={c.ynab !== c.magpie}><td>{c.name}</td><td class="money">{formatMoney(c.ynab)}</td><td class="money">{formatMoney(c.magpie)}</td></tr>
        {/each}
      </tbody>
    </table>
    <h4>Account balances</h4>
    <ul>{#each r.balances as b (b.name)}<li>{b.name}: <span class="money">{formatMoney(b.working)}</span></li>{/each}</ul>
    {#if isEmpty}
      <p><button data-testid="import" class="primary" onclick={() => void doYnabImport()} disabled={busy}>{busy ? 'Importing…' : 'Import'}</button></p>
    {:else}
      <p class="error" data-testid="import-blocked">This database already has data. Delete all data in <a href="#/settings">Settings</a> first.</p>
    {/if}
  {/if}
  </div>
</section>

<style>
  .import { max-width: 1100px; margin: 0 auto; padding: 16px 24px; display: flex; flex-direction: column; }
  /* An empty database wants the YNAB cutover first; afterwards statements lead. */
  .import.empty .ynab { order: 0; }
  .import.empty .statements { order: 1; margin-top: 40px; border-top: 1px solid var(--line); padding-top: 24px; }
  .import:not(.empty) h2.ynab { margin-top: 40px; border-top: 1px solid var(--line); padding-top: 24px; }
  .panel { background: var(--bg1); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; }
  .panel h3 { margin: 0 0 8px; }
  .files { display: flex; gap: 24px; flex-wrap: wrap; }
  .files label { display: flex; flex-direction: column; gap: 4px; }
  .mapping { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px 16px; margin: 8px 0; }
  .mapping label { display: grid; gap: 3px; color: var(--dim); font-size: 0.9rem; }
  .dim { color: var(--dim); }
  .error { color: var(--red); }
  .ok { color: var(--teal); }
  .warn { color: var(--amber); }
  .primary { border-color: var(--blue); color: var(--blue); }
  table { border-collapse: collapse; margin: 8px 0 16px; width: 100%; }
  th, td { padding: 4px 10px; border-bottom: 1px solid var(--line); text-align: left; }
  th.money, td.money { text-align: right; }
  td.date { font-family: var(--font-mono); font-size: 0.9rem; white-space: nowrap; }
  tr.skip td { color: var(--dim); }
  tr.match td.res { color: var(--blue); }
  tr.new td.res { color: var(--amber); }
  tr.mismatch td { color: var(--red); }
  select { font: inherit; color: var(--text); background: var(--bg2); border: 1px solid var(--line); border-radius: 4px; }
  a { color: var(--blue); }
</style>
