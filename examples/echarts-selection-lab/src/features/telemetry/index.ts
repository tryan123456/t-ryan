/**
 * The demo domain: a mock fleet-telemetry dataset, its query controls, its
 * table, and the adapter that binds it to the portable chart slice.
 *
 * Everything app-specific lives behind this barrel. Swapping the demo data for
 * a real source means changing this feature and nothing else.
 */

export { DATASET } from './data/generate'
export { DEFAULT_QUERY, runQuery, type QueryResult } from './data/query'
export { useQueryStore } from './queryStore'
export { CHART_SPECS, type ChartSpec } from './chartSpecs'
export { TelemetryScatterChart } from './TelemetryScatterChart'
export { DataTable } from './DataTable'
export { QueryPanel } from './QueryPanel'
export { Legend } from './Legend'
export type { Category, DataPoint, MetricKey, Query, Region, Status } from './types'
