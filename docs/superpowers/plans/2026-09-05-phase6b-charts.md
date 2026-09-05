# Phase 6b: Charts (built; notes for the next reader)

Built directly from spec §6 "Charts" and §4.8 with the dataviz skill's procedure: form first,
then a three-slot categorical palette validated against Magpie's chart surface (`#10151d`,
dark only) with `validate_palette.js`, mark specs, hover layer, table twins, then a
screenshot pass.

- `src/lib/domain/charts.ts`: series builders (net worth, income vs spending, category
  spending, investment income running total, loan history plus projection) and `niceTicks`.
- `src/lib/ui/charts/LineChart.svelte`, `BarChart.svelte`: inline SVG, width from an
  unpadded wrapper (`bind:clientWidth` on a padded element feeds back into itself), the
  whole month band as hit target, tooltips that never gate a value, a table toggle.
- `src/lib/ui/ChartsView.svelte`: one range row scopes every chart. `LoansView` embeds the
  balance-owed chart with the projection dashed and the what-if in slot 3.
- Rules kept: three series at most per chart; a legend at two or more; text in text tokens,
  never the series colour; solid hairline gridlines; no dual axes.
- Not done: texture fill for CVD/print; a category chart with several categories at once
  (small multiples would be the form); light mode (the app is dark only).
