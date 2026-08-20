/**
 * The two charts on screen, declared as data.
 *
 * Two measures of different scale get two charts — never two y-axes on one
 * chart. Both read the same rows and the same selection, so they are effectively
 * small multiples of one dataset seen through different metric pairs.
 */

import type { MetricKey } from './types'

export interface AxisSpec {
  key: MetricKey
  label: string
  unit: string
}

export interface ChartSpec {
  id: string
  title: string
  caption: string
  x: AxisSpec
  y: AxisSpec
}

export const CHART_SPECS: readonly ChartSpec[] = [
  {
    id: 'latency-throughput',
    title: 'Throughput vs latency',
    caption: 'Trend line is the mean throughput per latency bin.',
    x: { key: 'latencyMs', label: 'Latency', unit: ' ms' },
    y: { key: 'throughputRps', label: 'Throughput', unit: ' rps' },
  },
  {
    id: 'cpu-memory',
    title: 'Memory vs CPU',
    caption: 'Trend line is the mean memory per CPU bin.',
    x: { key: 'cpuPct', label: 'CPU', unit: '%' },
    y: { key: 'memoryPct', label: 'Memory', unit: '%' },
  },
]
