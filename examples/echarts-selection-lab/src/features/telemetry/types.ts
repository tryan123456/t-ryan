/**
 * Shared domain types.
 *
 * The dataset models fleet telemetry: each row is one host sampled once.
 * Three categories only — that is a deliberate constraint, not an accident:
 * a scatter plot puts every colour pair on screen at once, and the reference
 * palette only clears the all-pairs CVD floors for its first three slots.
 */

export const CATEGORIES = ['compute', 'storage', 'network'] as const
export type Category = (typeof CATEGORIES)[number]

export const REGIONS = ['us-east', 'us-west', 'eu-central', 'ap-north'] as const
export type Region = (typeof REGIONS)[number]

export const STATUSES = ['healthy', 'degraded', 'critical'] as const
export type Status = (typeof STATUSES)[number]

export interface DataPoint {
  id: string
  name: string
  category: Category
  region: Region
  status: Status
  /** ms since epoch */
  timestamp: number
  latencyMs: number
  throughputRps: number
  cpuPct: number
  memoryPct: number
  errorRatePct: number
}

/** Numeric fields that can be plotted on an axis. */
export type MetricKey = Extract<
  keyof DataPoint,
  'latencyMs' | 'throughputRps' | 'cpuPct' | 'memoryPct' | 'errorRatePct'
>

/** The full query — the single input to the data pipeline. */
export interface Query {
  search: string
  categories: Category[]
  regions: Region[]
  statuses: Status[]
  latencyRange: [number, number]
  /** Cap on plotted rows, so the perf envelope is user-visible. */
  limit: number
}

/**
 * Selection algebra. Every entry point (chart brush, chart click, table click,
 * checkbox, hotkey) funnels into exactly one of these.
 */
export type SelectionOp = 'replace' | 'add' | 'subtract' | 'toggle'

/**
 * Where a selection change came from. Used only to decide whether the table
 * should auto-scroll — the table must not yank itself around on its own clicks.
 */
export type SelectionSource = 'chart' | 'table' | 'system'
