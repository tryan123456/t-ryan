/**
 * scatter-select-chart — a portable slice.
 *
 * Dependencies: `react` and `echarts`. Nothing else. Copy this directory into
 * another project, install those two, and import from here.
 *
 * ```tsx
 * const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
 *
 * <ScatterSelectChart
 *   series={[{ id: 'a', name: 'Group A', color: '#2a78d6', rows }]}
 *   accessors={{ id: r => r.id, x: r => r.latency, y: r => r.throughput }}
 *   lines={[{ id: 'trend', name: 'Trend', color: '#52514e',
 *             points: binnedMean(rows, r => r.latency, r => r.throughput) }]}
 *   x={{ name: 'Latency', unit: ' ms' }}
 *   y={{ name: 'Throughput', unit: ' rps' }}
 *   chrome={neutralChrome.light}
 *   selectedIds={selected}
 *   onSelect={({ ids, op }) => setSelected(prev => applyOp(prev, ids, op))}
 * />
 * ```
 *
 * `series`, `accessors` and `lines` are dependencies of the internal model —
 * keep them referentially stable (`useMemo`) or the chart rebuilds every
 * render.
 */

export { ScatterSelectChart } from './ScatterSelectChart'
export { binnedMean, type BinnedMeanOptions } from './binnedMean'
export { neutralChrome } from './types'
export type {
  AxisSpec,
  ChartChrome,
  LineSpec,
  ScatterAccessors,
  ScatterSelectChartProps,
  ScatterSeriesSpec,
  SelectionChange,
  SelectionOp,
} from './types'
