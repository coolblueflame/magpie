<!-- Column chart, one or two series: bars at most 24px wide with a rounded data-end, a 2px surface gap, per-bar tooltip, optional reference lines, table twin. -->
<script lang="ts">
  import { formatMoney } from '../../domain/money';
  import { monthLabel } from '../../domain/month';
  import { niceTicks } from '../../domain/charts';
  import type { MonthPoint } from '../../domain/charts';

  export interface BarSeries { name: string; points: MonthPoint[]; slot: 1 | 2 | 3 }
  export interface RefLine { label: string; value: number }
  let { series, title, testid, refs = [], height = 220 }: { series: BarSeries[]; title: string; testid: string; refs?: RefLine[]; height?: number } = $props();

  let width = $state(600);
  const pad = { top: 16, right: 16, bottom: 28, left: 56 };
  const months = $derived(series[0]?.points.map((p) => p.month) ?? []);
  const max = $derived(Math.max(0, ...series.flatMap((s) => s.points.map((p) => p.value)), ...refs.map((r) => r.value)));
  const ticks = $derived(niceTicks(max));
  const top = $derived(ticks[ticks.length - 1] || 1);
  const plotW = $derived(Math.max(10, width - pad.left - pad.right));
  const plotH = $derived(height - pad.top - pad.bottom);
  const band = $derived(plotW / Math.max(1, months.length));
  const barW = $derived(Math.min(24, Math.max(2, (band - 8) / series.length - 2)));
  const groupW = $derived(series.length * barW + (series.length - 1) * 2);
  const x = (mi: number, si: number) => pad.left + mi * band + (band - groupW) / 2 + si * (barW + 2);
  const y = (v: number) => pad.top + ((top - Math.max(0, v)) / top) * plotH;
  const baseline = $derived(pad.top + plotH);
  /** A bar path with a 4px rounded top and a square foot on the baseline. */
  function bar(px: number, v: number): string {
    const h = Math.max(0, baseline - y(v));
    const r = Math.min(4, h, barW / 2);
    const x2 = px + barW, yTop = baseline - h;
    return `M${px},${baseline} V${yTop + r} Q${px},${yTop} ${px + r},${yTop} H${x2 - r} Q${x2},${yTop} ${x2},${yTop + r} V${baseline} Z`;
  }
  const colour = (slot: number) => `var(--series-${slot})`;
  let hover = $state<{ mi: number } | null>(null);
  /** The whole band is the hit target, not the painted bar. */
  function onMove(e: PointerEvent) {
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const mi = Math.floor((e.clientX - rect.left - pad.left) / band);
    hover = mi >= 0 && mi < months.length ? { mi } : null;
  }
  let table = $state(false);
  const labelEvery = $derived(Math.max(1, Math.ceil(months.length / 8)));
  const short = (m: string) => monthLabel(m).replace(' 20', ' ’');
</script>

<figure class="chart" data-testid={testid}>
  <figcaption><span class="title">{title}</span><button class="tbl" data-testid={`${testid}-table-toggle`} onclick={() => (table = !table)}>{table ? 'Chart' : 'Table'}</button></figcaption>
  {#if series.length >= 2 || refs.length}
    <ul class="legend">
      {#each series as s (s.name)}<li><span class="swatch" style={`--c:${colour(s.slot)}`}></span>{s.name}</li>{/each}
      {#each refs as r (r.label)}<li><span class="key"></span>{r.label} {formatMoney(r.value)}</li>{/each}
    </ul>
  {/if}
  {#if table}
    <table data-testid={`${testid}-table`}>
      <thead><tr><th>Month</th>{#each series as s (s.name)}<th class="num">{s.name}</th>{/each}</tr></thead>
      <tbody>{#each months as m, mi (m)}<tr><td>{monthLabel(m)}</td>{#each series as s (s.name)}<td class="num">{formatMoney(s.points[mi]?.value ?? 0)}</td>{/each}</tr>{/each}</tbody>
    </table>
  {:else}
    <div class="plot" bind:clientWidth={width}>
    <svg viewBox={`0 0 ${width} ${height}`} {width} {height} role="img" aria-label={title} onpointermove={onMove} onpointerleave={() => (hover = null)}>
      {#each ticks as t (t)}
        <line class="grid" x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} />
        <text class="axis" x={pad.left - 8} y={y(t) + 4} text-anchor="end">{formatMoney(t).replace('.00', '')}</text>
      {/each}
      {#each months as m, mi (m)}
        {#each series as s, si (s.name)}
          <path class="bar" class:lit={hover?.mi === mi} d={bar(x(mi, si), s.points[mi]?.value ?? 0)} style={`fill:${colour(s.slot)}`} />
        {/each}
        {#if mi % labelEvery === 0 || mi === months.length - 1}<text class="axis" x={pad.left + mi * band + band / 2} y={height - 8} text-anchor="middle">{short(m)}</text>{/if}
      {/each}
      {#each refs as r (r.label)}
        <line class="ref" x1={pad.left} x2={width - pad.right} y1={y(r.value)} y2={y(r.value)} />
        <text class="reflabel" x={width - pad.right} y={y(r.value) - 4} text-anchor="end">{r.label}</text>
      {/each}
    </svg>
    </div>
    {#if hover}
      {@const m = months[hover.mi]!}
      <div class="tip" data-testid={`${testid}-tip`} style={`left:${Math.min(pad.left + hover.mi * band + band, width - 180)}px`}>
        <div class="tipmonth">{monthLabel(m)}</div>
        {#each series as s (s.name)}<div class="tiprow"><span class="swatch" style={`--c:${colour(s.slot)}`}></span><b>{formatMoney(s.points[hover.mi]?.value ?? 0)}</b><span class="dim">{s.name}</span></div>{/each}
      </div>
    {/if}
  {/if}
</figure>

<style>
  .chart { --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --grid: #223040; --muted: #8c9bab;
    position: relative; margin: 0; background: var(--bg1); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px 6px; }
  figcaption { display: flex; align-items: baseline; gap: 10px; }
  .title { font-weight: 600; flex: 1; }
  .tbl { border: none; color: var(--dim); font-size: 0.85rem; padding: 0 6px; }
  .legend { list-style: none; display: flex; gap: 14px; margin: 4px 0 0; padding: 0; font-size: 0.85rem; color: var(--dim); flex-wrap: wrap; }
  .swatch { display: inline-block; width: 10px; height: 10px; background: var(--c); border-radius: 2px; vertical-align: middle; margin-right: 6px; }
  .key { display: inline-block; width: 14px; height: 2px; background: var(--muted); vertical-align: middle; margin-right: 6px; }
  .plot { width: 100%; }
  svg { display: block; overflow: visible; }
  .grid { stroke: var(--grid); stroke-width: 1; }
  .axis { fill: var(--muted); font-size: 11px; font-family: var(--font-sans); font-variant-numeric: tabular-nums; }
  .bar { opacity: 0.92; }
  .bar.lit { opacity: 1; filter: brightness(1.15); }
  .ref { stroke: var(--muted); stroke-width: 1; }
  .reflabel { fill: var(--muted); font-size: 11px; font-family: var(--font-sans); }
  .tip { position: absolute; top: 40px; background: var(--bg2); border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; font-size: 0.85rem; pointer-events: none; min-width: 150px; }
  .tipmonth { color: var(--dim); margin-bottom: 4px; }
  .tiprow { display: flex; align-items: center; gap: 8px; }
  .tiprow b { font-family: var(--font-mono); }
  .dim { color: var(--dim); }
  table { border-collapse: collapse; width: 100%; margin-top: 6px; font-size: 0.9rem; }
  th, td { padding: 3px 8px; border-bottom: 1px solid var(--line); text-align: left; }
  .num { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
</style>
