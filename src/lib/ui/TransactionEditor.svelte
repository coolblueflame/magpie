<!-- Inline editor for one transaction: date, payee, amounts, a target or split lines, cleared (spec §6 Ledger). -->
<script lang="ts">
  import { app } from '../state/app.svelte';
  import { formatCents, formatMoney, parseCents } from '../domain/money';
  import type { LineTarget, TxDraft } from '../domain/transactions';
  import CategoryPicker from './CategoryPicker.svelte';
  import { focusOnMount } from './focusOnMount';

  let { draft: initial, payeeName: initialPayee = '', note = '', shared: initialShared = null, onSave, onCancel, onDelete }: {
    draft: TxDraft; payeeName?: string; note?: string; shared?: { accountId: string; percent: number } | null;
    /** shared: undefined = unchanged (keep the stored split as edited), an object = re-derive, null = clear. */
    onSave: (draft: TxDraft, payeeName: string, shared: { accountId: string; percent: number } | null | undefined) => void | Promise<void>;
    onCancel: () => void; onDelete?: () => void;
  } = $props();

  // The editor is mounted per edit, so capturing the initial props is the intent.
  // svelte-ignore state_referenced_locally
  let d = $state<TxDraft>({ ...$state.snapshot(initial), lines: $state.snapshot(initial).lines.map((l) => ({ ...l })) });
  // svelte-ignore state_referenced_locally
  let payee = $state(initialPayee);
  // svelte-ignore state_referenced_locally
  let outflow = $state(initial.outflow ? formatCents(initial.outflow) : '');
  // svelte-ignore state_referenced_locally
  let inflow = $state(initial.inflow ? formatCents(initial.inflow) : '');
  // svelte-ignore state_referenced_locally
  let lineText = $state<string[]>(initial.lines.map((l) => formatCents(Math.abs(l.amount))));
  let error = $state('');
  // svelte-ignore state_referenced_locally
  let sharedPerson = $state(initialShared?.accountId ?? '');
  // svelte-ignore state_referenced_locally
  let sharedPercent = $state(initialShared ? String(initialShared.percent) : '');
  const personAccounts = $derived(app.state.accounts.filter((a) => a.kind === 'person' && !a.closed));
  const canShare = $derived(() => { const a = app.state.accounts.find((x) => x.id === d.accountId); return !!a?.onBudget && a.kind !== 'person' && personAccounts.length > 0; });
  const sharedChoice = $derived.by((): { accountId: string; percent: number } | null => {
    if (!canShare() || !sharedPerson) return null;
    const p = Number(sharedPercent);
    return Number.isFinite(p) && p > 0 && p <= 100 ? { accountId: sharedPerson, percent: p } : null;
  });

  const total = $derived((parseCents(inflow || '0') ?? 0) - (parseCents(outflow || '0') ?? 0));
  const sign = $derived(total < 0 ? -1 : 1);
  const lineSum = $derived(d.lines.reduce((s, l) => s + l.amount, 0));
  const remainder = $derived(total - lineSum);
  const canSave = $derived(total !== 0 && (!d.split || (remainder === 0 && d.lines.length > 0)));
  const accountsById = $derived(new Map(app.state.accounts.map((a) => [a.id, a])));
  /** A transfer between a budget account and a tracking account also needs a category (spec §4.3). */
  const xferNeedsCategory = (t: LineTarget) =>
    t.type === 'transfer' && accountsById.get(d.accountId)?.onBudget !== accountsById.get(t.accountId)?.onBudget;

  function setLineAmount(i: number, text: string) {
    lineText[i] = text;
    const v = parseCents(text);
    if (v !== null) d.lines[i]!.amount = sign * v;
  }
  function toggleSplit() {
    if (!d.split) {
      d.split = true;
      d.lines = [{ target: d.target, amount: total, memo: '' }, { target: { type: 'none' }, amount: 0, memo: '' }];
      lineText = [formatCents(Math.abs(total)), ''];
    } else {
      d.split = false;
      d.target = d.lines[0]?.target ?? { type: 'none' };
      d.lines = [];
      lineText = [];
    }
  }
  function addLine() {
    d.lines.push({ target: { type: 'none' }, amount: remainder, memo: '' });
    lineText.push(remainder ? formatCents(Math.abs(remainder)) : '');
  }
  function removeLine(i: number) { d.lines.splice(i, 1); lineText.splice(i, 1); }
  function withCategory(t: LineTarget, categoryId: string | undefined): LineTarget {
    return t.type === 'transfer' ? { ...t, ...(categoryId ? { categoryId } : { categoryId: undefined }) } : t;
  }
  async function save() {
    error = '';
    try {
      // Only a changed share re-derives the lines; a memo edit on a claim-based split must not.
      const key = (s: { accountId: string; percent: number } | null | undefined) => (s ? `${s.accountId}|${s.percent}` : '');
      const sharedArg = key(initialShared) === key(sharedChoice) ? undefined : (sharedChoice ?? null);
      await onSave({ ...$state.snapshot(d), outflow: total < 0 ? -total : 0, inflow: total > 0 ? total : 0 }, payee.trim(), sharedArg);
    } catch (e) { error = (e as Error).message; }
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && canSave) void save();
    if (e.key === 'Escape') onCancel();
  }
</script>

<div class="editor" data-testid="editor">
  {#if note}<p class="note">{note}</p>{/if}
  <div class="grid">
    <label>Date <input type="date" data-testid="ed-date" bind:value={d.date} use:focusOnMount onkeydown={onKey} /></label>
    <label>Payee <input data-testid="ed-payee" list="payee-list" bind:value={payee} onkeydown={onKey} /></label>
    <datalist id="payee-list">{#each app.state.payees as p (p.id)}<option value={p.name}></option>{/each}</datalist>
    <label>Outflow <input data-testid="ed-outflow" class="money" bind:value={outflow} onkeydown={onKey} /></label>
    <label>Inflow <input data-testid="ed-inflow" class="money" bind:value={inflow} onkeydown={onKey} /></label>
    <label class="wide">Memo <input data-testid="ed-memo" bind:value={d.memo} onkeydown={onKey} /></label>
    <label class="check"><input type="checkbox" data-testid="ed-cleared" checked={d.cleared === 'cleared'}
      onchange={(e) => (d.cleared = e.currentTarget.checked ? 'cleared' : 'uncleared')} /> Cleared</label>
  </div>
  {#if !d.split}
    <div class="target">
      <label>Category <CategoryPicker testid="ed-target" value={d.target} accountId={d.accountId} onChange={(t) => (d.target = t)} /></label>
      {#if xferNeedsCategory(d.target)}
        <label>Budget category for this transfer
          <CategoryPicker testid="ed-xfer-category" mode="categories" accountId={d.accountId}
            value={d.target.type === 'transfer' && d.target.categoryId ? { type: 'category', categoryId: d.target.categoryId } : { type: 'none' }}
            onChange={(t) => (d.target = withCategory(d.target, t.type === 'category' ? t.categoryId : undefined))} />
        </label>
      {/if}
    </div>
  {:else}
    <table class="lines">
      <tbody>
        {#each d.lines as line, i (i)}
          <tr>
            <td><CategoryPicker testid={`ed-line-${i}-target`} value={line.target} accountId={d.accountId} onChange={(t) => (line.target = t)} /></td>
            {#if xferNeedsCategory(line.target)}
              <td><CategoryPicker testid={`ed-line-${i}-xfer-category`} mode="categories" accountId={d.accountId}
                value={line.target.type === 'transfer' && line.target.categoryId ? { type: 'category', categoryId: line.target.categoryId } : { type: 'none' }}
                onChange={(t) => (line.target = withCategory(line.target, t.type === 'category' ? t.categoryId : undefined))} /></td>
            {/if}
            <td><input data-testid={`ed-line-${i}-amount`} class="money" value={lineText[i] ?? ''} oninput={(e) => setLineAmount(i, e.currentTarget.value)} /></td>
            <td><input data-testid={`ed-line-${i}-memo`} placeholder="Memo" bind:value={line.memo} /></td>
            <td><button data-testid={`ed-line-remove-${i}`} title="Remove line" onclick={() => removeLine(i)}>×</button></td>
          </tr>
        {/each}
        <tr><td colspan="5">
          <button data-testid="ed-line-add" onclick={addLine}>Add line</button>
          <span data-testid="ed-remainder" class="remainder" class:neg={remainder !== 0}>Remainder {formatMoney(remainder)}</span>
        </td></tr>
      </tbody>
    </table>
  {/if}
  {#if canShare()}
    <div class="shared">
      <label>Shared with
        <select data-testid="ed-shared-person" bind:value={sharedPerson}>
          <option value="">Not shared</option>
          {#each personAccounts as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
        </select>
      </label>
      {#if sharedPerson}
        <label>Their share % <input data-testid="ed-shared-percent" class="money" bind:value={sharedPercent} onkeydown={onKey} /></label>
        <span class="dim">Saving re-derives the lines: your share to the category, the rest to {personAccounts.find((p) => p.id === sharedPerson)?.name}.</span>
      {/if}
    </div>
  {/if}
  <div class="actions">
    <button data-testid="ed-split" onclick={toggleSplit}>{d.split ? 'Unsplit' : 'Split'}</button>
    <span class="spacer"></span>
    {#if onDelete}<button data-testid="ed-delete" class="danger" onclick={onDelete}>Delete</button>{/if}
    <button data-testid="ed-cancel" onclick={onCancel}>Cancel</button>
    <button data-testid="ed-save" class="primary" disabled={!canSave} onclick={() => void save()}>Save</button>
  </div>
  {#if error}<p class="error" data-testid="ed-error">{error}</p>{/if}
</div>

<style>
  .editor { background: var(--bg1); border: 1px solid var(--blue-deep); border-radius: 8px; padding: 12px; display: grid; gap: 10px; text-align: left; font-size: 0.95rem; }
  .note { margin: 0; color: var(--amber); }
  .grid { display: grid; grid-template-columns: 150px 1fr 120px 120px; gap: 10px 14px; align-items: end; }
  label { display: grid; gap: 3px; color: var(--dim); min-width: 0; }
  .grid input { width: 100%; min-width: 0; }
  label.wide { grid-column: 1 / 3; }
  label.check { display: flex; align-items: center; gap: 6px; }
  .money { text-align: right; font-family: var(--font-mono); }
  .target { display: flex; gap: 14px; }
  .shared { display: flex; gap: 14px; align-items: end; }
  .shared select { font: inherit; color: var(--text); background: var(--bg2); border: 1px solid var(--line); border-radius: 4px; padding: 3px 6px; }
  .shared .dim { color: var(--dim); font-size: 0.85rem; }
  .lines { border-collapse: collapse; }
  .lines td { padding: 3px 6px 3px 0; }
  .remainder { margin-left: 12px; color: var(--teal); font-family: var(--font-mono); }
  .remainder.neg { color: var(--red); }
  .actions { display: flex; gap: 8px; }
  .spacer { flex: 1; }
  .danger { color: var(--red); border-color: var(--red); }
  .primary { border-color: var(--blue); color: var(--blue); }
  .error { color: var(--red); margin: 0; }
</style>
