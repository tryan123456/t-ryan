/**
 * Mean of y within equal-width x bins — the usual companion line for a scatter.
 *
 * Offered as a convenience so the common case does not need its own module.
 * The chart takes precomputed line points, so any other fit works equally well.
 */

export interface BinnedMeanOptions {
  bins?: number
  /** Bins thinner than this are noise, not trend. */
  minPopulation?: number
}

export function binnedMean<TRow>(
  rows: readonly TRow[],
  x: (row: TRow) => number,
  y: (row: TRow) => number,
  { bins = 28, minPopulation = 3 }: BinnedMeanOptions = {},
): [number, number][] {
  if (rows.length < minPopulation * 2) return []

  let min = Infinity
  let max = -Infinity
  for (const row of rows) {
    const value = x(row)
    if (value < min) min = value
    if (value > max) max = value
  }
  if (!(max > min)) return []

  const width = (max - min) / bins
  const sums = new Float64Array(bins)
  const counts = new Uint32Array(bins)

  for (const row of rows) {
    const bin = Math.min(bins - 1, Math.floor((x(row) - min) / width))
    sums[bin] += y(row)
    counts[bin]++
  }

  const points: [number, number][] = []
  for (let i = 0; i < bins; i++) {
    if (counts[i] < minPopulation) continue
    points.push([min + width * (i + 0.5), sums[i] / counts[i]])
  }
  return points
}
