<!-- Every imported row still to categorise, with the payee's last category pre-filled (spec §4.5, §4.6). -->
<script lang="ts">
  import { app } from '../state/app.svelte';
  import { undoStack } from '../state/undo.svelte';
  import { toast } from './toast.svelte';
  import { payeeLastCategory } from '../domain/payees';
  import { formatMoney } from '../domain/money';
  import type { LineTarget } from '../domain/transactions';
  import CategoryPicker from './CategoryPicker.svelte';

  const accountsById = $derived(new Map(app.state.accounts.map((a) => [a.id, a])));
  const items = $derived(app.state.transactions
    .filter((t) => t.status === 'new' && accountsById.get(t.accountId)?.onBudget)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)));
  const prefill = (payeeId?: string): LineTarget => {
    const c = payeeId ? payeeLastCategory(payeeId, $state.snapshot(app.state.transactions), accountsById) : undefined;
    return c ? { type: 'category', categoryId: c } : { type: 'none' };
  };
  /** Explicit picks by transaction id; anything else shows its pre-fill. */
  let picks = $state<Record<string, LineTarget>>({});
  const targetFor = (id: string, payeeId?: string) => picks[id] ?? prefill(payeeId);
  const prefilled = $derived(items.filter((t) => !picks[t.id] && prefill(t.payeeId).type !== 'none'));
  const payeeName = (pid?: string) => (pid ? app.state.payees.find((p) => p.id === pid)?.name ?? '' : '');
  const accountName = (aid: string) => accountsById.get(aid)?.name ?? '';
  let error = $state('');
  let armed = $state(false);
  let armTimer: ReturnType<typeof setTimeout> | undefined;

  async function confirm(id: string, payeeId?: string) {
    error = '';
    try {
      await app.confirmTransaction(id, targetFor(id, payeeId));
      toast.show('Confirmed', () => void undoStack.undo());
    } catch (e) { error = (e as Error).message; }
  }
  async function confirmPrefilled() {
    if (!armed) { armed = true; armTimer = setTimeout(() => (armed = false), 5000); return; }
    clearTimeout(armTimer);
    armed = false;
    const batch = prefilled.map((t) => ({ id: t.id, target: prefill(t.payeeId) }));
    await app.confirmAll(batch);
    toast.show(`Confirmed ${batch.length} transactions`, () => void undoStack.undo());
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
  {#if !items.length}
    <p class="dim" data-testid="rv-empty">Nothing to review. Every imported row has a category.</p>
  {:else}
    <table>
      <thead><tr><th>Account</th><th>Date</th><th>Payee</th><th>Memo</th><th class="money">Amount</th><th>Category</th><th></th></tr></thead>
      <tbody>
        {#each items as t (t.id)}
          <tr data-testid={`rv-${t.id}`} class:prefilled={!picks[t.id] && prefill(t.payeeId).type !== 'none'}>
            <td>{accountName(t.accountId)}</td>
            <td class="date">{t.date}</td>
            <td>{payeeName(t.payeeId)}</td>
            <td class="dim">{t.memo}</td>
            <td class={`money ${t.amount < 0 ? 'neg' : 'pos'}`}>{formatMoney(t.amount)}</td>
            <td><CategoryPicker testid={`rv-target-${t.id}`} value={targetFor(t.id, t.payeeId)} accountId={t.accountId} onChange={(v) => (picks[t.id] = v)} /></td>
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
</style>
