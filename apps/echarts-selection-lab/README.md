# Fleet telemetry explorer

Two linked ECharts scatter + trend charts and a virtualised raw-data table,
sharing one selection. React 19 · TypeScript · Vite · ECharts 6 · TanStack
Table v9 + Virtual + Hotkeys · Zustand.

```bash
npm install
npm run dev
```

## Slices

```
                       ┌──────────────────────────────┐
   App.tsx ──────────► │ features/telemetry           │  demo domain
   (pipeline + layout) │  data · query · table · UI   │
                       │  TelemetryScatterChart ──────┼──┐  the adapter
                       └───────────┬──────────────────┘  │
                                   │                     ▼
                       ┌───────────▼──────────┐  ┌──────────────────────────┐
                       │ features/selection   │  │ features/                │
                       │  store · algebra     │  │   scatter-select-chart   │
                       │  hotkeys · bar       │  │  react + echarts ONLY    │
                       └───────────┬──────────┘  └──────────────────────────┘
                                   ▼
                            shared/ (format, theme)
```

Dependencies only ever point downward, and `scatter-select-chart` points
nowhere at all.

### `features/scatter-select-chart` — the portable one

Copy the directory into another project, install `react` and `echarts`, import
from `index.ts`. It has no other dependency: no store, no domain types, no
design tokens, no formatting helpers. Verified mechanically —

```bash
grep -rhoE "from '[^']+'" src/features/scatter-select-chart/ | sort -u
```

resolves to relative paths, `react`, and `echarts/*`, and nothing outside the
slice reaches past its `index.ts`.

It is **fully controlled**: it renders `selectedIds` and reports gestures
through `onSelect`. Owning no selection state is exactly what lets two of them
— or one of them and a table — stay in sync without knowing about each other.

Rows stay in the host's own shape, read through accessors, so using it needs no
mapping pass into a chart-specific point type:

```tsx
<ScatterSelectChart
  series={[{ id: 'compute', name: 'Compute', color: '#2a78d6', rows }]}
  accessors={{ id: r => r.id, x: r => r.latencyMs, y: r => r.throughputRps }}
  lines={[{ id: 'trend', name: 'Trend', color: '#52514e',
            points: binnedMean(rows, r => r.latencyMs, r => r.throughputRps) }]}
  x={{ name: 'Latency', unit: ' ms' }}
  y={{ name: 'Throughput', unit: ' rps' }}
  chrome={neutralChrome.light}
  selectedIds={selected}
  onSelect={({ ids, op }) => setSelected(prev => applyOp(prev, ids, op))}
/>
```

`series`, `accessors`, `lines` and the axis specs are dependencies of the
internal model — keep them referentially stable or the chart rebuilds every
render. `features/telemetry/TelemetryScatterChart.tsx` is the worked example of
that, and of the whole adapter role: grouping rows, resolving palette slots for
the active theme, computing the trend, and connecting `onSelect` to the store.

## The one architectural idea

**Selection is a single source of truth that nothing else duplicates.**

```
                    useSelectionStore
                  ids · anchorId · source
                    ▲       ▲       ▲
      apply(ids, op)│       │       │  subscribe
        ┌───────────┴──┬────┴───────┴────────┐
  TelemetryScatter  TelemetryScatter     DataTable
     (chart A)         (chart B)
```

Neither ECharts' built-in `select` state nor TanStack Table's
`rowSelectionFeature` is registered. Both are deliberately absent: each would
be a second copy of the selection that has to be reconciled with the first, and
reconciliation is where sync bugs live. Every surface is a pure function of the
store, and every gesture is one call to `apply(ids, op)`.

`features/selection/algebra.ts` holds `applyOp` and `expandRange` — no React,
no ECharts, no DOM. What it deliberately does *not* hold is the canvas modifier
convention: that lives inside the chart slice, because a scatter is an icon view
and a table is a list view and they genuinely disagree about what shift means.
What they share is the `SelectionOp` vocabulary and `applyOp`, which is the part
that has to agree. The slice declares a structurally identical `SelectionOp` of
its own so it stays standalone; the two are assignable both ways at zero cost.

## Modifier behaviour

Two surfaces, two OS conventions — matching a file manager's list view and
icon view respectively.

| Gesture | Table (list view) | Chart (icon view / canvas) |
|---|---|---|
| plain click | replace with row | replace with point; on empty canvas, clear |
| ⌘/Ctrl + click | toggle row | toggle point |
| ⇧ + click | range from anchor (replaces) | add point |
| ⌘/Ctrl + ⇧ + click | range from anchor (unions) | add point |
| ⌥ + click | — | subtract point |
| drag | — | marquee: replace (⇧/⌘ add, ⌥ subtract) |

`Mod+A` select all visible · `Mod+I` invert · `Escape` clear. `Mod` resolves to
⌘ on macOS and Ctrl elsewhere, and the on-screen hints are rendered from the
same declarations via `formatForDisplay`, so a binding and its label cannot
drift apart.

Range selection walks `orderedIds` — the table's current post-filter,
post-sort order — so shift-select follows what is on screen, never the raw
dataset order.

## The marquee never sticks around

ECharts keeps the brush rectangle on screen after mouse-up and treats it as
live state. That is not how selection works anywhere else, so:

1. `brushEnd` fires on pointer release. We read `areas[0].coordRange` — the
   rectangle already in data space — and intersect it against the chart model
   ourselves (`pointsInRect`).
2. We then dispatch `{ type: 'brush', areas: [] }` to erase the rectangle and
   re-arm the brush cursor (`internal/brush.ts`).

The box is transient drag feedback; the *points* are the result.

We deliberately do **not** use the `brushSelected` event. It is throttled, so
on a fast drag-and-release its last payload can be stale by the time `brushEnd`
arrives. Computing the hit test from the event's own rectangle removes that
race entirely, and also makes the result independent of `progressive`
rendering.

Click-vs-drag is decided by pointer travel (4px). Under the threshold the
gesture is a click, resolved by a nearest-point search with a 10px hit radius —
a hit target larger than the mark.

## Rendering the selection

Series indexes are laid out by rule, for N scatter series and M lines:

| index | series |
|---|---|
| `0 .. N-1` | base scatter, one per series — the only brushable ones |
| `N .. 2N-1` | selected overlay, one per series, with direct labels |
| `2N+2i` | line *i*'s halo (surface-coloured, 6px) |
| `2N+2i+1` | line *i* (2px) |

When anything is selected, the base clouds drop to 14% opacity and the overlay
draws the selected points at full opacity with a 2px surface ring and a label.
Splitting base from overlay means a selection change never re-uploads the point
data — `buildSelectionPatch` emits 2N entries that merge by index and leave the
lines alone, while `buildBaseOption` only runs when the data changes.

## Label placement

Labels on selected points are laid out by `internal/labelPlacement.ts`, not by
ECharts. Both built-in options are wrong for a scatter:

- `hideOverlap` only *drops* labels, in list order, so a dense cluster keeps
  whichever happen to come first and silently loses the rest.
- `moveOverlap: 'shiftY'` sorts every label by y and forces them into one
  non-overlapping vertical stack **ignoring x entirely** — right for a pie
  chart's label column, badly wrong for a 2D cloud.

So placement runs in pixel space in two stages: **thin** (at most one label per
14px grid cell, so labels spread evenly instead of piling into the first
cluster) then **place** (try eight positions per point — cardinals first, then
diagonals — take the first whose box hits nothing already placed and stays
inside the plot). Greedy rather than optimal, because optimal point-feature
labelling is NP-hard. Points where nothing fits keep their highlighted dot and
get no label. `hideOverlap` stays on as a backstop.

Text is measured on a real canvas context (cached), because
`length × averageCharWidth` is off by enough to cause visible overlap. The
projection to pixels is a two-probe affine derived from the model's data
extent — both axes are linear `value` axes — rather than one `convertToPixel`
call per point.

Verified over 8 scenarios (sparse, dense, tight cluster, 5000 points, all
points on one pixel): zero overlapping label boxes, zero boxes outside the
plot, ~0.5ms for 2000 candidates. An 800×340 plot saturates at roughly 100
labels whatever the parameters, which is a property of the geometry rather than
the algorithm.

Above 2000 selected points labels are switched off entirely — not a placement
limit but a readability one, and the chart caption says so.

## Data flow

```
DATASET (50k, seeded, module-level, immutable)
  └─ runQuery(query)  → rows  ──┬─→ buildModel  → ECharts option
                                └─→ TanStack Table → virtualised rows
```

The dataset is generated once with a seeded PRNG so a bug is always
reproducible, and lives outside React state because it never changes. Query
state and selection state are separate stores — they change for different
reasons, at different rates, and re-render different things.

Selection is **not** pruned when the query narrows: losing a careful selection
because a filter moved is worse than a number that needs explaining, so the
selection bar reports "N selected · M outside the current query" instead.

## Colour

Three categories, not more, and that is a data-visualisation constraint rather
than a modelling one: a scatter puts every colour pair on screen at once, and
the palette only clears the all-pairs CVD floors for its first three slots.
Both modes validated (`--pairs all`): light CVD ΔE 9.2 / normal-vision 24.0,
dark 9.4 / 20.9. Light-mode aqua sits at 2.74:1 against the surface, which
triggers the relief rule — hence the direct labels on selected points and the
full table view. The trend line wears ink, not a fourth category colour,
because it is an annotation rather than a series.

Dark mode is a separately stepped, separately validated set — not an inversion.
Tokens live twice on purpose: `lib/theme.ts` for the canvas (which cannot read
CSS custom properties) and `styles/tokens.css` for DOM chrome.

## Layout

```
src/
  App.tsx                          composition root: pipeline + layout only
  shared/
    format.ts  theme.ts            formatting, chrome tokens, light/dark switch

  features/scatter-select-chart/   ── PORTABLE: react + echarts only ──
    index.ts                       the public surface
    types.ts                       props, specs, SelectionOp, neutralChrome
    ScatterSelectChart.tsx         controlled component
    binnedMean.ts                  optional trend helper
    internal/
      echarts.ts                   the only ECharts registration point
      model.ts                     rows -> plot tuples, hit tests, overlay
      option.ts                    base option; selection patch
      brush.ts                     arm / clear the marquee
      labelPlacement.ts            thin + greedy placement (pure)
      measureText.ts               cached canvas text measurement
      labelLayout.ts               pixel projection -> placement
      resolveOp.ts                 canvas modifier convention
      useEchart.ts                 instance lifecycle + resize signal
      usePointerSelection.ts       gestures -> SelectionChange

  features/selection/              the SSOT
    store.ts  algebra.ts  useSelectionHotkeys.ts  SelectionBar.tsx

  features/telemetry/              the demo domain
    data/generate.ts               seeded 50k-row mock dataset
    data/query.ts                  pure filter engine
    queryStore.ts  types.ts  palette.ts  chartSpecs.ts
    TelemetryScatterChart.tsx      adapter -> scatter-select-chart
    DataTable.tsx  QueryPanel.tsx  Legend.tsx
```

## Notes

- Shortcuts use `@tanstack/react-hotkeys`. One `useHotkeys` call registers the
  whole list from `features/selection/shortcuts.ts`, which is what makes it
  valid to drive the bindings from data; callbacks re-sync every render, so
  there is no dependency array and no stale-closure hazard.
  `ignoreInputs: true` is set explicitly — it otherwise defaults to `false` for
  Mod combos and Escape, which would hijack Cmd+A and Esc while the user is
  typing in the search box.
- TanStack Table v9 gates feature APIs on registration, so `features` in
  `DataTable.tsx` is the table's entire capability surface.
- ECharts is imported through `charts/echarts.ts` with only the four components
  in use registered — 1.4 MB → 816 kB.
