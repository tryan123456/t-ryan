/**
 * The plot model: host rows, read once through the accessors, into the compact
 * shape ECharts and the hit-testing want.
 *
 * Rows themselves are never copied — the model keeps the host's arrays and a
 * position index, so tooltips and labels can still reach the original row.
 */

import type { LineSpec, ScatterAccessors, ScatterSeriesSpec } from '../types'

/** One ECharts data item: `[x, y, id]`. The id rides along for hit resolution. */
export type Plot = [number, number, string]

export interface Bounds {
  xMin: number
  xMax: number
  yMin: number
  yMax: number
}

export interface ChartModel<TRow> {
  series: readonly ScatterSeriesSpec<TRow>[]
  lines: readonly LineSpec[]
  /** Plot tuples per series, index-aligned with `series[i].rows`. */
  data: Plot[][]
  /** id → [seriesIndex, rowIndex]. */
  index: Map<string, [number, number]>
  /** Data-space extent, for the affine data→pixel projection. */
  bounds: Bounds
  rowOf: (id: string) => TRow | undefined
  seriesOf: (id: string) => ScatterSeriesSpec<TRow> | undefined
  labelOf: (id: string) => string
}

export function buildModel<TRow>(
  series: readonly ScatterSeriesSpec<TRow>[],
  accessors: ScatterAccessors<TRow>,
  lines: readonly LineSpec[],
): ChartModel<TRow> {
  const label = accessors.label ?? accessors.id
  const data: Plot[][] = series.map(() => [])
  const index = new Map<string, [number, number]>()

  let xMin = Infinity
  let xMax = -Infinity
  let yMin = Infinity
  let yMax = -Infinity

  series.forEach((group, seriesIndex) => {
    const bucket = data[seriesIndex]
    group.rows.forEach((row, rowIndex) => {
      const x = accessors.x(row)
      const y = accessors.y(row)
      const id = accessors.id(row)

      index.set(id, [seriesIndex, rowIndex])
      bucket.push([x, y, id])

      if (x < xMin) xMin = x
      if (x > xMax) xMax = x
      if (y < yMin) yMin = y
      if (y > yMax) yMax = y
    })
  })

  const locate = (id: string) => {
    const at = index.get(id)
    return at ? { series: series[at[0]], row: series[at[0]].rows[at[1]] } : null
  }

  return {
    series,
    lines,
    data,
    index,
    bounds: { xMin, xMax, yMin, yMax },
    rowOf: (id) => locate(id)?.row,
    seriesOf: (id) => locate(id)?.series,
    labelOf: (id) => {
      const found = locate(id)
      return found ? label(found.row) : id
    },
  }
}

/** Data-space rectangle → the ids inside it. Used by the marquee. */
export function pointsInRect(
  data: readonly Plot[][],
  [[x0, x1], [y0, y1]]: [[number, number], [number, number]],
): string[] {
  const xMin = Math.min(x0, x1)
  const xMax = Math.max(x0, x1)
  const yMin = Math.min(y0, y1)
  const yMax = Math.max(y0, y1)

  const hits: string[] = []
  for (const bucket of data) {
    for (const [x, y, id] of bucket) {
      if (x >= xMin && x <= xMax && y >= yMin && y <= yMax) hits.push(id)
    }
  }
  return hits
}

/**
 * Nearest point to a data-space location within an elliptical tolerance, also
 * in data units — the caller converts a pixel hit radius through the axis
 * scales. Returns null when the click landed on empty canvas.
 */
export function nearestPoint(
  data: readonly Plot[][],
  x: number,
  y: number,
  toleranceX: number,
  toleranceY: number,
): string | null {
  let best: string | null = null
  let bestDistance = 1

  for (const bucket of data) {
    for (const [px, py, id] of bucket) {
      const dx = (px - x) / toleranceX
      const dy = (py - y) / toleranceY
      const distance = dx * dx + dy * dy
      if (distance <= bestDistance) {
        bestDistance = distance
        best = id
      }
    }
  }
  return best
}

/** Selected points that actually have a plotted position, grouped by series. */
export function collectOverlay(
  model: ChartModel<unknown>,
  selectedIds: ReadonlySet<string>,
): Plot[][] {
  const overlay: Plot[][] = model.series.map(() => [])

  for (const id of selectedIds) {
    const at = model.index.get(id)
    // Selected rows the host filtered out simply have no point to draw here —
    // the selection itself is left alone.
    if (!at) continue
    overlay[at[0]].push(model.data[at[0]][at[1]])
  }

  return overlay
}
