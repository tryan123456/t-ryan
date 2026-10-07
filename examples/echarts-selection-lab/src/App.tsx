/**
 * Composition root.
 *
 * Owns the data pipeline (dataset → query → rows) and the layout, and nothing
 * else. Selection lives in its own slice precisely so this component does not
 * have to broker it between the charts and the table.
 */

import { useCallback, useMemo, useState } from 'react'
import { SelectionBar, useSelectionHotkeys } from './features/selection'
import {
  CHART_SPECS,
  DATASET,
  DataTable,
  Legend,
  QueryPanel,
  TelemetryScatterChart,
  runQuery,
  useQueryStore,
} from './features/telemetry'
import { useThemeStamp } from './shared/theme'
import './styles/app.css'

const NO_IDS: readonly string[] = []

export default function App() {
  useThemeStamp()

  const query = useQueryStore((state) => state.query)
  const result = useMemo(() => runQuery(DATASET, query), [query])

  // The table owns the sort, so it also owns the order that shift-range and
  // "select all" operate on. It reports that order up here.
  const [orderedIds, setOrderedIds] = useState<readonly string[]>(NO_IDS)
  const handleOrderChange = useCallback((ids: string[]) => setOrderedIds(ids), [])

  useSelectionHotkeys(orderedIds)

  return (
    <div className="app">
      <header className="app__head">
        <h1 className="app__title">Fleet telemetry explorer</h1>
        <p className="app__subtitle">
          Two linked scatter + trend charts and the raw rows behind them, sharing
          one selection.
        </p>
      </header>

      <QueryPanel
        matched={result.matched}
        plotted={result.rows.length}
        total={result.total}
      />

      <Legend />

      <div className="chart-grid">
        {CHART_SPECS.map((spec) => (
          <TelemetryScatterChart key={spec.id} spec={spec} rows={result.rows} />
        ))}
      </div>

      <SelectionBar orderedIds={orderedIds} />

      <DataTable rows={result.rows} onOrderChange={handleOrderChange} />
    </div>
  )
}
