/**
 * Point-feature label placement.
 *
 * ECharts offers two built-in answers and neither fits a scatter plot:
 *
 * - `hideOverlap` only *drops* labels, in list order, so a dense cluster keeps
 *   whichever labels happen to come first and silently loses the rest.
 * - `moveOverlap: 'shiftY'` sorts every label by y and forces them into one
 *   non-overlapping vertical stack, ignoring x entirely. That is right for a
 *   pie chart's label column and badly wrong for a 2D cloud — labels end up
 *   nowhere near their points.
 *
 * So placement is done here, in pixel space, in two stages:
 *
 *   1. **Thin.** Keep at most one label per grid cell, so what gets labelled is
 *      spread evenly across the plot instead of piling into the first cluster
 *      encountered. This also bounds the work in stage 2.
 *   2. **Place.** For each surviving point try eight positions around it
 *      (cardinals first, then diagonals) and take the first whose box hits no
 *      already-placed box and stays inside the plot. Points where nothing fits
 *      keep their highlighted dot and simply get no label.
 *
 * Greedy rather than optimal: optimal point-feature labelling is NP-hard, and
 * greedy-with-candidates is the standard practical answer. Everything here is
 * pure — the caller supplies pixel coordinates and measured text sizes.
 */

export type Align = 'left' | 'center' | 'right'
export type VerticalAlign = 'top' | 'middle' | 'bottom'

export interface LabelCandidate {
  id: string
  /** Anchor — the symbol's centre, in chart pixels. */
  px: number
  py: number
  width: number
  height: number
}

export interface Placement {
  /** Offset from the symbol centre, for ECharts' `label.offset`. */
  offset: [number, number]
  align: Align
  verticalAlign: VerticalAlign
}

export interface PlacementOptions {
  /** Plot area in chart pixels. */
  width: number
  height: number
  /** Gap between the symbol centre and the near edge of the label. */
  distance?: number
  /** Grid cell for stage 1. Larger = fewer, more evenly spread labels. */
  thinCell?: number
  /** Hard ceiling on labels attempted, so a huge selection stays responsive. */
  budget?: number
  /** Keeps labels off the very edge of the canvas. */
  margin?: number
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Unit directions, in preference order: straight up first (it reads as the
 * conventional "label above the dot"), then the other cardinals, then the
 * diagonals as fallbacks.
 */
const DIRECTIONS: readonly [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
  [0.7071, -0.7071],
  [0.7071, 0.7071],
  [-0.7071, -0.7071],
  [-0.7071, 0.7071],
]

function alignFor(ux: number): Align {
  if (ux > 0.01) return 'left'
  if (ux < -0.01) return 'right'
  return 'center'
}

function verticalAlignFor(uy: number): VerticalAlign {
  if (uy > 0.01) return 'top'
  if (uy < -0.01) return 'bottom'
  return 'middle'
}

/** Where the text box lands, given an anchor and how the text hangs off it. */
function rectFor(
  anchorX: number,
  anchorY: number,
  width: number,
  height: number,
  align: Align,
  verticalAlign: VerticalAlign,
): Rect {
  const x =
    align === 'left' ? anchorX : align === 'right' ? anchorX - width : anchorX - width / 2
  const y =
    verticalAlign === 'top'
      ? anchorY
      : verticalAlign === 'bottom'
        ? anchorY - height
        : anchorY - height / 2
  return { x, y, w: width, h: height }
}

/** Grid cell key. The grid is small enough that hash collisions cost nothing. */
const cellKey = (cx: number, cy: number) => cx * 73_856_093 + cy

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/**
 * Uniform-grid index over placed boxes. Collision checks stay local instead of
 * scanning every label placed so far, which is what keeps this linear-ish.
 */
function createRectIndex(cell: number) {
  const cells = new Map<number, Rect[]>()

  const bounds = (rect: Rect) => ({
    x0: Math.floor(rect.x / cell),
    x1: Math.floor((rect.x + rect.w) / cell),
    y0: Math.floor(rect.y / cell),
    y1: Math.floor((rect.y + rect.h) / cell),
  })

  return {
    intersects(rect: Rect): boolean {
      const { x0, x1, y0, y1 } = bounds(rect)
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const bucket = cells.get(cellKey(cx, cy))
          if (!bucket) continue
          for (const other of bucket) if (overlaps(rect, other)) return true
        }
      }
      return false
    },

    insert(rect: Rect) {
      const { x0, x1, y0, y1 } = bounds(rect)
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const key = cellKey(cx, cy)
          const bucket = cells.get(key)
          if (bucket) bucket.push(rect)
          else cells.set(key, [rect])
        }
      }
    },
  }
}

/** Stage 1 — at most one candidate per grid cell, in input order. */
function thin(
  candidates: readonly LabelCandidate[],
  cell: number,
  budget: number,
): LabelCandidate[] {
  const taken = new Set<number>()
  const kept: LabelCandidate[] = []

  for (const candidate of candidates) {
    if (kept.length >= budget) break
    const key = cellKey(
      Math.floor(candidate.px / cell),
      Math.floor(candidate.py / cell),
    )
    if (taken.has(key)) continue
    taken.add(key)
    kept.push(candidate)
  }

  return kept
}

export function placeLabels(
  candidates: readonly LabelCandidate[],
  options: PlacementOptions,
): Map<string, Placement> {
  const placements = new Map<string, Placement>()
  if (candidates.length === 0) return placements

  // Defaults tuned by sweep: for a typical 800x340 plot with ~90px labels the
  // plot saturates around 100 labels no matter what, so these buy the last few
  // percent of fill (87 -> 96 labels at 5000 candidates) for about a
  // millisecond. Going finer than this is measurably pointless.
  const {
    width,
    height,
    distance = 9,
    thinCell = 14,
    budget = 1200,
    margin = 2,
  } = options

  const kept = thin(candidates, thinCell, budget)

  // Cell sized to the typical label keeps each collision query to a handful of
  // buckets; too small and every box spans many cells, too large and each
  // bucket degenerates into a linear scan.
  const index = createRectIndex(48)

  for (const candidate of kept) {
    for (const [ux, uy] of DIRECTIONS) {
      const align = alignFor(ux)
      const verticalAlign = verticalAlignFor(uy)
      const offsetX = ux * distance
      const offsetY = uy * distance
      const rect = rectFor(
        candidate.px + offsetX,
        candidate.py + offsetY,
        candidate.width,
        candidate.height,
        align,
        verticalAlign,
      )

      const insideBounds =
        rect.x >= margin &&
        rect.y >= margin &&
        rect.x + rect.w <= width - margin &&
        rect.y + rect.h <= height - margin
      if (!insideBounds || index.intersects(rect)) continue

      index.insert(rect)
      placements.set(candidate.id, {
        offset: [offsetX, offsetY],
        align,
        verticalAlign,
      })
      break
    }
  }

  return placements
}
