/**
 * Turns the current selection into concrete label positions.
 *
 * The bridge between the chart instance (which knows the pixel geometry) and
 * `labelPlacement` (which is pure). Separate from `option.ts` because it is the
 * one part of the option that cannot be computed from data alone — it needs the
 * live axis scales, so it also has to re-run on resize.
 */

import type { ECharts } from './echarts'
import type { ChartModel, Plot } from './model'
import {
  LABEL_BOX_HEIGHT,
  LABEL_BOX_PADDING_X,
  LABEL_FONT,
  SELECTED_SYMBOL_SIZE,
} from './option'
import { measureTextWidth } from './measureText'
import { placeLabels, type LabelCandidate, type Placement } from './labelPlacement'

/** Symbol radius plus a small gap, so text clears the dot's surface ring. */
const LABEL_DISTANCE = SELECTED_SYMBOL_SIZE / 2 + 4

interface Affine {
  toPixelX: (x: number) => number
  toPixelY: (y: number) => number
}

/**
 * A two-probe affine projection instead of one `convertToPixel` call per point.
 *
 * Both axes are linear `value` axes, so data→pixel is affine and two probes pin
 * it down exactly. Calling into ECharts thousands of times per selection change
 * would dominate the cost of everything else here.
 */
function projectionOf(chart: ECharts, model: ChartModel<unknown>): Affine | null {
  const { xMin, xMax, yMin, yMax } = model.bounds
  if (!Number.isFinite(xMin) || !Number.isFinite(yMin)) return null

  const finder = { gridIndex: 0 }
  const low = chart.convertToPixel(finder, [xMin, yMin]) as number[] | undefined
  const high = chart.convertToPixel(finder, [xMax, yMax]) as number[] | undefined
  if (!low || !high) return null

  // A degenerate extent (every row shares an x) has no gradient to recover;
  // pin those points to the probe pixel rather than dividing by zero.
  const spanX = xMax - xMin
  const spanY = yMax - yMin
  const scaleX = spanX === 0 ? 0 : (high[0] - low[0]) / spanX
  const scaleY = spanY === 0 ? 0 : (high[1] - low[1]) / spanY

  return {
    toPixelX: (x) => low[0] + (x - xMin) * scaleX,
    toPixelY: (y) => low[1] + (y - yMin) * scaleY,
  }
}

/**
 * Returns null when labels should be suppressed altogether — nothing selected,
 * too much selected, or the chart has no usable geometry yet.
 */
export function computeLabelPlacements(
  chart: ECharts,
  model: ChartModel<unknown>,
  overlay: Plot[][],
  maxLabelledSelection: number,
): ReadonlyMap<string, Placement> | null {
  const total = overlay.reduce((sum, bucket) => sum + bucket.length, 0)
  if (total === 0 || total > maxLabelledSelection) return null

  const width = chart.getWidth()
  const height = chart.getHeight()
  if (!width || !height) return null

  const projection = projectionOf(chart, model)
  if (!projection) return null

  // Round-robin across series rather than draining one bucket at a time.
  // Placement is greedy and first-come-first-served, so feeding it series 0 in
  // full would systematically hand that colour every contested slot.
  const candidates: LabelCandidate[] = []
  const longest = overlay.reduce((max, bucket) => Math.max(max, bucket.length), 0)
  for (let i = 0; i < longest; i++) {
    for (const bucket of overlay) {
      const point = bucket[i]
      if (!point) continue
      const [x, y, id] = point
      candidates.push({
        id,
        px: projection.toPixelX(x),
        py: projection.toPixelY(y),
        width: measureTextWidth(model.labelOf(id), LABEL_FONT) + LABEL_BOX_PADDING_X,
        height: LABEL_BOX_HEIGHT,
      })
    }
  }

  return placeLabels(candidates, { width, height, distance: LABEL_DISTANCE })
}
