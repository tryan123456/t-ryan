/**
 * Mock dataset.
 *
 * Seeded so every reload produces the same rows — a moving dataset makes
 * selection bugs impossible to reproduce. Generated once at module load and
 * never mutated, so it lives outside React state entirely.
 */

import {
  CATEGORIES,
  REGIONS,
  type Category,
  type DataPoint,
  type Status,
} from '../types'

export const DATASET_SIZE = 50_000

/** mulberry32 — small, fast, good enough for mock data, fully deterministic. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Box–Muller, so clusters look like real telemetry instead of a uniform blob. */
function gaussian(rand: () => number, mean: number, stdDev: number): number {
  const u = Math.max(rand(), Number.EPSILON)
  const v = rand()
  return mean + stdDev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Per-category centroids — gives each colour a visually distinct cluster. */
const PROFILES: Record<
  Category,
  { latency: [number, number]; cpu: [number, number]; efficiency: number }
> = {
  compute: { latency: [95, 38], cpu: [68, 15], efficiency: 24 },
  storage: { latency: [180, 60], cpu: [42, 18], efficiency: 14 },
  network: { latency: [45, 22], cpu: [30, 12], efficiency: 38 },
}

function generate(size: number): DataPoint[] {
  const rand = mulberry32(0x5eed_1234)
  const now = Date.UTC(2026, 7, 19)
  const rows: DataPoint[] = new Array(size)

  for (let i = 0; i < size; i++) {
    const category = CATEGORIES[Math.floor(rand() * CATEGORIES.length)]
    const region = REGIONS[Math.floor(rand() * REGIONS.length)]
    const profile = PROFILES[category]

    const latencyMs = clamp(gaussian(rand, ...profile.latency), 4, 600)
    const cpuPct = clamp(gaussian(rand, ...profile.cpu), 1, 99)

    // Throughput falls off as latency rises — gives the trend line something
    // real to describe rather than a flat average through noise.
    const throughputRps = clamp(
      (profile.efficiency * 1000) / latencyMs + gaussian(rand, 0, 45),
      5,
      4000,
    )
    // Memory tracks CPU loosely, so chart B is correlated but not redundant.
    const memoryPct = clamp(cpuPct * 0.75 + gaussian(rand, 18, 12), 1, 99)
    const errorRatePct = clamp(
      Math.pow(rand(), 3) * 12 + (latencyMs > 300 ? 1.5 : 0),
      0,
      100,
    )

    const status: Status =
      errorRatePct > 6 || cpuPct > 92
        ? 'critical'
        : errorRatePct > 2.2 || latencyMs > 260
          ? 'degraded'
          : 'healthy'

    rows[i] = {
      id: `n-${i.toString(36).padStart(4, '0')}`,
      name: `${category.slice(0, 3)}-${region}-${i.toString().padStart(5, '0')}`,
      category,
      region,
      status,
      timestamp: now - Math.floor(rand() * 30 * 864e5),
      latencyMs: Math.round(latencyMs * 10) / 10,
      throughputRps: Math.round(throughputRps),
      cpuPct: Math.round(cpuPct * 10) / 10,
      memoryPct: Math.round(memoryPct * 10) / 10,
      errorRatePct: Math.round(errorRatePct * 100) / 100,
    }
  }

  return rows
}

/** The immutable source dataset. Query it; never edit it. */
export const DATASET: readonly DataPoint[] = generate(DATASET_SIZE)
