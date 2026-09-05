<!-- Every imported row still to categorise, with the payee's last category pre-filled (spec §4.5, §4.6). -->
<script lang="ts">
  import { app } from '../state/app.svelte';
  import { undoStack } from '../state/undo.svelte';
  import { toast, undoToast } from './toast.svelte';
  import { payeeLastCategories, suggestPayee } from '../domain/payees';
  import { formatMoney } from '../domain/money';
  import type { LineTarget } from '../domain/transactions';
  import CategoryPicker from './CategoryPicker.svelte';

  const accountsById = $derived(new Map(app.state.accounts.map((a) => [a.id, a])));
  const items = $derived(app.state.transactions
    .filter((t) => t.status === 'new' && accountsById.get(t.accountId)?.onBudget)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)));
  // One pass over the table per change, not one per row per render.
  const lastCategories = $derived(payeeLastCategories(app.transactionsSnap, accountsById));
  const prefill = (payeeId?: string): LineTarget => {
    const c = payeeId ? lastCategories.get(payeeId) : undefined;
    return c ? { type: 'category', categoryId: c } : { type: 'none' };
  };
  /** Explicit picks by transaction id; anything else shows its pre-fill. */
  let picks = $state<Record<string, LineTarget>>({});
  /** For a row whose payee has no history: the existing payee it probably is (spec §10 payee suggestions). */
  const sameAs = (payeeId?: string) => {
    if (!payeeId || lastCategories.has(payeeId)) return null;
    const p = app.state.payees.find((x) => x.id === payeeId);
    return p ? suggestPayee(p.name, app.payeesSnap, (id) => lastCategories.has(id), payeeId) : null;
  };
  async function acceptSameAs(payeeId: string, into: string) {
    await app.mergePayees([payeeId, into], into);
    undoToast('Merged payee');
  }
  const targetFor = (id: string, payeeId?: string) => picks[id] ?? prefill(payeeId);
  const prefilled = $derived(items.filter((t) => !picks[t.id] && prefill(t.payeeId).type !== 'none'));
  const payeeName = (pid?: string) => (pid ? app.state.payees.find((p) => p.id === pid)?.name ?? '' : '');
  const accountName = (aid: string) => accountsById.get(aid)?.name ?? '';

  // Open share claims (spec §5.4): rows the user paid on the shared sheet that no bank row has claimed yet.
  const openClaims = $derived(app.state.claims.filter((c) => c.status === 'open').sort((a, b) => (a.date < b.date ? -1 : 1)));
  const personAccountId = $derived(app.state.settings.sheet?.personAccountId ?? '');
  const dayDiff = (a: string, b: string) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);
  const candidatesFor = (claim: { paid: number; date: string }) => app.state.transactions
    .filter((t) => {
      const a = accountsById.get(t.accountId);
      return a?.onBudget && a.kind !== 'person' && t.lines.length === 1 && !t.lines[0]!.transferAccountId && !t.shared && t.amount === -claim.paid && dayDiff(t.date, claim.date) <= 45;
    })
    .sort((a, b) => dayDiff(a.date, claim.date) - dayDiff(b.date, claim.date));
  let claimPicks = $state<Record<string, string>>({});
  async function applyClaim(id: string) {
    const cands = candidatesFor(openClaims.find((c) => c.id === id)!);
    // A pick made earlier may no longer be a candidate (the row got shared some other way).
    const picked = claimPicks[id];
    if (picked && !cands.some((t) => t.id === picked)) delete claimPicks[id];
    const txId = cands.find((t) => t.id === claimPicks[id])?.id ?? cands[0]?.id;
    if (!txId || !personAccountId) return;
    error = '';
    try {
      await app.applyClaim(id, txId, personAccountId);
      undoToast('Applied shared claim');
    } catch (e) { error = (e as Error).message; }
  }
  async function dismissClaim(id: string) {
    await app.dismissClaim(id);
    undoToast('Dismissed claim');
  }
  let error = $state('');
  let armed = $state(false);
  let armTimer: ReturnType<typeof setTimeout> | undefined;

  async function confirm(id: string, payeeId?: string) {
    error = '';
    try {
      await app.confirmTransaction(id, targetFor(id, payeeId));
      undoToast('Confirmed');
    } catch (e) { error = (e as Error).message; }
  }
  async function confirmPrefilled() {
    if (!armed) { armed = true; armTimer = setTimeout(() => (armed = false), 5000); return; }
    clearTimeout(armTimer);
    armed = false;
    const batch = prefilled.map((t) => ({ id: t.id, target: prefill(t.payeeId) }));
    await app.confirmAll(batch);
    undoToast(`Confirmed ${batch.length} transactions`);
  }
</script>

<section class="review">
  <header>
    <h2>Review</h2>
    <span class="dim" data-testid="rv-count">{items.length} to categorise</span>
    <span class="spacer"></span>
    {#if prefilled.length}
      <button data-testid="confirm-prefilled" class:armed onclick={() => void confirmPrefilled()} onblur={() => (armed = false)}>
        {armed ? `Confirm ${prefilled.length} pre-filled rows?` : `Confirm ${prefilled.length} pre-filled`}
      </button>
    {/if}
  </header>
  {#if error}<p class="error" data-testid="rv-error">{error}</p>{/if}
  {#if openClaims.length}
    <h3>Shared claims <span class="dim" data-testid="claim-count">{openClaims.length} waiting for a bank row</span></h3>
    <table class="claims">
      <thead><tr><th>Date</th><th>Description</th><th class="money">You paid</th><th class="money">Their share</th><th>Bank row</th><th></th></tr></thead>
      <tbody>
        {#each openClaims as c (c.id)}
          {@const cands = candidatesFor(c)}
          <tr data-testid={`claim-${c.id}`}>
            <td class="date">{c.date}</td>
            <td>{c.description}{#if c.categoryHint} <span class="dim">· {c.categoryHint}</span>{/if}</td>
            <td class="money">{formatMoney(c.paid)}</td>
            <td class="money">{c.percent}%</td>
            <td>
              {#if cands.length}
                <select data-testid={`claim-pick-${c.id}`} value={claimPicks[c.id] ?? cands[0]!.id} onchange={(e) => (claimPicks[c.id] = e.currentTarget.value)}>
                  {#each cands as t (t.id)}<option value={t.id}>{t.date} · {accountName(t.accountId)} · {payeeName(t.payeeId) || t.memo}</option>{/each}
                </select>
              {:else}<span class="dim">no matching row yet</span>{/if}
            </td>
            <td>
              {#if cands.length && personAccountId}<button data-testid={`claim-apply-${c.id}`} class="primary" onclick={() => void applyClaim(c.id)}>Apply</button>{/if}
              <button data-testid={`claim-dismiss-${c.id}`} onclick={() => void dismissClaim(c.id)}>Dismiss</button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
  {#if !items.length}
    <p class="dim" data-testid="rv-empty">Nothing to review. Every imported row has a category.</p>
  {:else}
    <table>
      <thead><tr><th>Account</th><th>Date</th><th>Payee</th><th>Memo</th><th class="money">Amount</th><th>Category</th><th></th></tr></thead>
      <tbody>
        {#each items as t (t.id)}
          {@const same = sameAs(t.payeeId)}
          <tr data-testid={`rv-${t.id}`} class:prefilled={!picks[t.id] && prefill(t.payeeId).type !== 'none'}>
            <td>{accountName(t.accountId)}</td>
            <td class="date">{t.date}</td>
            <td>{payeeName(t.payeeId)}
              {#if same}<button class="same" data-testid={`rv-same-${t.id}`} title={`Treat as ${same.payee.name} from now on`} onclick={() => void acceptSameAs(t.payeeId!, same.payee.id)}>Same as {same.payee.name}?</button>{/if}
            </td>
            <td class="dim">{t.memo}</td>
            <td class={`money ${t.amount < 0 ? 'neg' : 'pos'}`}>{formatMoney(t.amount)}</td>
            <td onkeydown={(e) => { if (e.key === 'Enter') void confirm(t.id, t.payeeId); }}>
              <CategoryPicker testid={`rv-target-${t.id}`} value={targetFor(t.id, t.payeeId)} accountId={t.accountId} onChange={(v) => (picks[t.id] = v)} />
            </td>
            <td><button data-testid={`rv-confirm-${t.id}`} class="primary" onclick={() => void confirm(t.id, t.payeeId)}>Confirm</button></td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>

<style>
  .review { max-width: 1200px; margin: 0 auto; padding: 16px 24px; }
  header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; }
  h2 { margin: 0; }
  .dim { color: var(--dim); }
  .spacer { flex: 1; }
  .error { color: var(--red); }
  button.armed { border-color: var(--red); color: var(--red); }
  .primary { border-color: var(--blue); color: var(--blue); }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: var(--dim); font-weight: 500; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  th.money { text-align: right; }
  td { padding: 6px 8px; border-bottom: 1px solid var(--line); }
  td.money { text-align: right; }
  td.date { font-family: var(--font-mono); font-size: 0.9rem; }
  tr.prefilled td { background: rgba(79, 209, 197, 0.05); }
  .same { margin-left: 8px; border: 1px dashed var(--line); color: var(--dim); font-size: 0.85rem; padding: 0 8px; }
  .same:hover { color: var(--blue); border-color: var(--blue); }
  h3 { color: var(--blue); margin: 4px 0 8px; display: flex; gap: 10px; align-items: baseline; font-size: 1rem; }
  .claims { margin-bottom: 20px; }
  select { font: inherit; color: var(--text); background: var(--bg2); border: 1px solid var(--line); border-radius: 4px; max-width: 320px; }
</style>
