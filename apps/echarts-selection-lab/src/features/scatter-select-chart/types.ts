/**
 * Public API of the scatter-select-chart slice.
 *
 * Everything the host application needs to know lives in this file. The slice
 * depends on `react` and `echarts` and nothing else — no store, no domain
 * types, no design tokens — so it can be copied into another project as a
 * directory.
 *
 * Rows stay in the host's own shape: the chart reads them through accessors
 * rather than requiring a mapping pass into a chart-specific point type.
 */

/**
 * How a gesture should change the selection.
 *
 * Structurally identical to whatever union the host already uses, so wiring
 * `onSelect` to an existing selection reducer usually needs no adapter.
 */
export type SelectionOp = 'replace' | 'add' | 'subtract' | 'toggle'

/** One coloured group of points. Colour follows the series, never its rank. */
export interface ScatterSeriesSpec<TRow> {
  id: string
  /** Shown in tooltips and used for the ECharts series name. */
  name: string
  color: string
  rows: readonly TRow[]
}

/** How to read a row. `label` defaults to `id`. */
export interface ScatterAccessors<TRow> {
  id: (row: TRow) => string
  x: (row: TRow) => number
  y: (row: TRow) => number
  label?: (row: TRow) => string
}

/** An overlaid line — a trend, a fit, a threshold. Drawn above the points. */
export interface LineSpec {
  id: string
  name: string
  color: string
  points: readonly (readonly [number, number])[]
}

export interface AxisSpec {
  name: string
  /** Suffix for tick labels and tooltip values, e.g. `' ms'` or `'%'`. */
  unit?: string
  /** Tick formatter. Defaults to a compact notation formatter. */
  format?: (value: number) => string
}

/**
 * Chart chrome colours. Canvas cannot read CSS custom properties, so the host
 * resolves its tokens to literals and passes them in. `neutralChrome` provides
 * a working default for both modes.
 */
export interface ChartChrome {
  surface: string
  textPrimary: string
  textSecondary: string
  textMuted: string
  gridline: string
  axisLine: string
  tooltipBg: string
  brushFill: string
  brushBorder: string
}

/** What the chart emits. The host decides what to do with it. */
export interface SelectionChange {
  ids: readonly string[]
  op: SelectionOp
  /**
   * The clicked point, when the gesture was a click on one — the host can use
   * it as the anchor for a subsequent range selection elsewhere in the UI.
   * Absent for marquee gestures, which have no single origin point.
   */
  anchorId?: string | null
}

export interface ScatterSelectChartProps<TRow> {
  series: readonly ScatterSeriesSpec<TRow>[]
  accessors: ScatterAccessors<TRow>
  lines?: readonly LineSpec[]
  x: AxisSpec
  y: AxisSpec
  chrome: ChartChrome

  /** The selection. The chart renders it and never owns it. */
  selectedIds: ReadonlySet<string>
  onSelect: (change: SelectionChange) => void

  /** Replaces the default tooltip body. Return HTML. */
  renderTooltip?: (row: TRow, series: ScatterSeriesSpec<TRow>) => string
  /**
   * Above this many *visible* selected points, labels are suppressed — not a
   * placement limit but a readability one. Default 2000.
   */
  maxLabelledSelection?: number
  className?: string
  style?: React.CSSProperties
}

/**
 * A working chrome for both modes, so the slice renders sensibly before the
 * host has wired its own tokens. Substitute your design system's values.
 */
export const neutralChrome: Record<'light' | 'dark', ChartChrome> = {
  light: {
    surface: '#fcfcfb',
    textPrimary: '#0b0b0b',
    textSecondary: '#52514e',
    textMuted: '#898781',
    gridline: '#e1e0d9',
    axisLine: '#c3c2b7',
    tooltipBg: '#ffffff',
    brushFill: 'rgba(42,120,214,0.10)',
    brushBorder: '#2a78d6',
  },
  dark: {
    surface: '#1a1a19',
    textPrimary: '#ffffff',
    textSecondary: '#c3c2b7',
    textMuted: '#898781',
    gridline: '#2c2c2a',
    axisLine: '#383835',
    tooltipBg: '#232322',
    brushFill: 'rgba(57,135,229,0.16)',
    brushBorder: '#3987e5',
  },
}
