/**
 * Pure ECharts option construction, split by update frequency:
 *
 *   buildBaseOption     — the whole chart (rows / axes / chrome changed)
 *   buildSelectionPatch — only the series a selection change affects
 *
 * The split matters. Selection changes on every click and drag, and rebuilding
 * a 20k-point option each time is wasteful. The patch merges by series index,
 * so a selection update never re-uploads the base point data.
 *
 * Series index layout, for N scatter series and M lines:
 *
 *   0     .. N-1        base scatter, one per series (the brushable ones)
 *   N     .. 2N-1       selected overlay, one per series
 *   2N+2i               line i's halo (surface-coloured, sits underneath)
 *   2N+2i+1             line i
 */

import type { EChartsOption } from './echarts'
import type { ChartModel, Plot } from './model'
import type { Align, Placement, VerticalAlign } from './labelPlacement'
import type { AxisSpec, ChartChrome, ScatterSeriesSpec } from '../types'

const BASE_SYMBOL_SIZE = 8
export const SELECTED_SYMBOL_SIZE = 11
const DIMMED_OPACITY = 0.14
const NORMAL_OPACITY = 0.8

/**
 * Label metrics. The font shorthand must match the label style exactly —
 * placement measures text with it, so a mismatch means wrongly-sized boxes and
 * labels that overlap anyway.
 */
export const LABEL_FONT_SIZE = 11
export const LABEL_FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", sans-serif'
export const LABEL_FONT = `${LABEL_FONT_SIZE}px ${LABEL_FONT_FAMILY}`
/** Line box plus room for the 3px text halo, so boxes never touch. */
export const LABEL_BOX_HEIGHT = 16
export const LABEL_BOX_PADDING_X = 5

const compact = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
})
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })

const tickFormatter = (axis: AxisSpec) =>
  axis.format ?? ((value: number) => compact.format(value))

const formatValue = (value: number, unit = '') => `${decimal.format(value)}${unit}`

export const baseSeriesIndexes = (count: number) =>
  Array.from({ length: count }, (_, i) => i)

function buildAxis(axis: AxisSpec, chrome: ChartChrome) {
  const format = tickFormatter(axis)
  const unit = (axis.unit ?? '').trim()

  return {
    type: 'value' as const,
    name: axis.name,
    nameTextStyle: { color: chrome.textSecondary, fontSize: 11 },
    axisLabel: {
      color: chrome.textMuted,
      fontSize: 11,
      formatter: (value: number) => format(value) + unit,
    },
    axisLine: { show: true, lineStyle: { color: chrome.axisLine } },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: chrome.gridline, width: 1 } },
    scale: true,
  }
}

export function buildBaseOption<TRow>(
  model: ChartModel<TRow>,
  x: AxisSpec,
  y: AxisSpec,
  chrome: ChartChrome,
  renderTooltip?: (row: TRow, series: ScatterSeriesSpec<TRow>) => string,
): EChartsOption {
  const count = model.series.length

  const scatterSeries = model.series.map((group, i) => ({
    id: `base-${group.id}`,
    name: group.name,
    type: 'scatter' as const,
    data: model.data[i],
    symbolSize: BASE_SYMBOL_SIZE,
    itemStyle: { color: group.color, opacity: NORMAL_OPACITY },
    emphasis: { scale: 1.4, focus: 'none' as const },
    progressive: 4000,
    progressiveThreshold: 4000,
    animation: false,
    z: 2,
  }))

  const selectedSeries = model.series.map((group) => ({
    id: `selected-${group.id}`,
    name: `${group.name} (selected)`,
    type: 'scatter' as const,
    data: [] as Plot[],
    symbolSize: SELECTED_SYMBOL_SIZE,
    // A 2px surface ring keeps a selected dot legible on a dense cloud.
    itemStyle: {
      color: group.color,
      opacity: 1,
      borderColor: chrome.surface,
      borderWidth: 2,
    },
    label: {
      show: false,
      // Anchored at the symbol centre; `offset` and alignment come from the
      // placement pass, per data item.
      position: 'inside' as const,
      fontSize: LABEL_FONT_SIZE,
      fontFamily: LABEL_FONT_FAMILY,
      color: chrome.textPrimary,
      // Halo rather than a label box — no extra rectangle over the data.
      textBorderColor: chrome.surface,
      textBorderWidth: 3,
      formatter: (params: { value: unknown }) =>
        model.labelOf((params.value as Plot)[2]),
    },
    // Backstop only. Placement should already have resolved collisions; this
    // catches the residue if a measured box came out slightly optimistic.
    labelLayout: { hideOverlap: true },
    animation: false,
    z: 4,
  }))

  const lineSeries = model.lines.flatMap((line) => [
    {
      id: `${line.id}-halo`,
      name: `${line.name} halo`,
      type: 'line' as const,
      data: line.points as unknown as number[][],
      symbol: 'none' as const,
      smooth: 0.2,
      lineStyle: { color: chrome.surface, width: 6, opacity: 0.9 },
      silent: true,
      animation: false,
      z: 5,
    },
    {
      id: line.id,
      name: line.name,
      type: 'line' as const,
      data: line.points as unknown as number[][],
      symbol: 'none' as const,
      smooth: 0.2,
      lineStyle: { color: line.color, width: 2 },
      animation: false,
      z: 6,
    },
  ])

  return {
    backgroundColor: 'transparent',
    animation: false,
    grid: { left: 8, right: 18, top: 16, bottom: 8, containLabel: true },
    xAxis: buildAxis(x, chrome),
    yAxis: buildAxis(y, chrome),
    tooltip: {
      trigger: 'item',
      backgroundColor: chrome.tooltipBg,
      borderColor: chrome.gridline,
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { color: chrome.textPrimary, fontSize: 12 },
      formatter: (params: unknown) => {
        const p = params as { seriesIndex: number; seriesName: string; value: unknown }

        if (p.seriesIndex >= count * 2) {
          const [vx, vy] = p.value as [number, number]
          return [
            `<b>${p.seriesName}</b>`,
            `${x.name} ${formatValue(vx, x.unit)}`,
            `${y.name} ${formatValue(vy, y.unit)}`,
          ].join('<br/>')
        }

        const id = (p.value as Plot)[2]
        const row = model.rowOf(id)
        const group = model.seriesOf(id)
        if (!row || !group) return ''
        if (renderTooltip) return renderTooltip(row, group)

        const [vx, vy] = p.value as Plot
        return [
          `<b>${model.labelOf(id)}</b>`,
          group.name,
          `${x.name} ${formatValue(vx, x.unit)}`,
          `${y.name} ${formatValue(vy, y.unit)}`,
        ].join('<br/>')
      },
    },
    brush: {
      toolbox: [],
      // Only the base scatter is brushable; overlay and lines must not be.
      seriesIndex: baseSeriesIndexes(count),
      brushType: 'rect',
      brushMode: 'single',
      transformable: false,
      removeOnClick: false,
      brushStyle: {
        borderWidth: 1,
        borderColor: chrome.brushBorder,
        color: chrome.brushFill,
      },
      // The slice owns the selected/unselected styling. ECharts' own brush
      // visuals are neutralised so it cannot double-dim or leave points stuck
      // highlighted after the marquee is cleared.
      inBrush: {},
      outOfBrush: { colorAlpha: 1 },
    },
    series: [...scatterSeries, ...selectedSeries, ...lineSeries],
  }
}

/** A label a point may or may not get, depending on whether it found room. */
type OverlayItem =
  | Plot
  | {
      value: Plot
      label: {
        show: boolean
        offset?: [number, number]
        align?: Align
        verticalAlign?: VerticalAlign
      }
    }

/**
 * The selection-only delta: dim the base clouds, populate the overlay.
 *
 * Returns exactly 2N entries, which merge by index onto the scatter series and
 * leave the line series untouched.
 *
 * `placements` comes from the pixel-space placement pass. Points missing from
 * it keep their highlighted dot and get no label — there was nowhere to put one
 * without colliding.
 */
export function buildSelectionPatch<TRow>(
  model: ChartModel<TRow>,
  hasSelection: boolean,
  overlay: Plot[][],
  chrome: ChartChrome,
  placements?: ReadonlyMap<string, Placement>,
): EChartsOption {
  const count = model.series.length
  const showLabels = Boolean(placements && placements.size > 0)
  const series = new Array(count * 2)

  model.series.forEach((group, i) => {
    const points = overlay[i]
    const data: OverlayItem[] = showLabels
      ? points.map((point) => {
          const placement = placements!.get(point[2])
          return placement
            ? {
                value: point,
                label: {
                  show: true,
                  offset: placement.offset,
                  align: placement.align,
                  verticalAlign: placement.verticalAlign,
                },
              }
            : { value: point, label: { show: false } }
        })
      : points

    series[i] = {
      itemStyle: {
        color: group.color,
        opacity: hasSelection ? DIMMED_OPACITY : NORMAL_OPACITY,
      },
    }
    series[count + i] = {
      data,
      itemStyle: { color: group.color, borderColor: chrome.surface },
      label: { show: showLabels },
    }
  })

  return { series }
}
