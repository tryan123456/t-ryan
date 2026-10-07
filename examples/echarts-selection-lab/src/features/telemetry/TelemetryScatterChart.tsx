/**
 * The adapter between this app and the portable chart slice.
 *
 * Everything domain-shaped lives here: grouping rows by category, resolving
 * palette slots for the current theme, computing the trend line, and connecting
 * the chart's `onSelect` to the selection store. The slice below it knows none
 * of that.
 *
 * It subscribes to the selection store itself rather than taking selection as a
 * prop, so a selection change re-renders one chart card instead of the whole
 * page.
 */

import { useCallback, useMemo } from 'react'
import {
  ScatterSelectChart,
  binnedMean,
  type ScatterAccessors,
  type ScatterSeriesSpec,
  type SelectionChange,
} from '../scatter-select-chart'
import { useSelectionStore } from '../selection'
import { useChartChrome, useThemeMode } from '../../shared/theme'
import { formatCount, formatValue } from '../../shared/format'
import { CATEGORY_COLOR, CATEGORY_LABEL, TREND_COLOR } from './palette'
import { CATEGORIES, type DataPoint } from './types'
import type { ChartSpec } from './chartSpecs'

interface Props {
  spec: ChartSpec
  rows: readonly DataPoint[]
}

export function TelemetryScatterChart({ spec, rows }: Props) {
  const mode = useThemeMode()
  const chrome = useChartChrome()
  const selectedIds = useSelectionStore((state) => state.ids)
  const apply = useSelectionStore((state) => state.apply)

  const byCategory = useMemo(() => {
    const groups = new Map<string, DataPoint[]>(
      CATEGORIES.map((category) => [category, []]),
    )
    for (const row of rows) groups.get(row.category)!.push(row)
    return groups
  }, [rows])

  const series = useMemo<ScatterSeriesSpec<DataPoint>[]>(
    () =>
      CATEGORIES.map((category) => ({
        id: category,
        name: CATEGORY_LABEL[category],
        color: CATEGORY_COLOR[mode][category],
        rows: byCategory.get(category)!,
      })),
    [byCategory, mode],
  )

  const accessors = useMemo<ScatterAccessors<DataPoint>>(
    () => ({
      id: (row) => row.id,
      x: (row) => row[spec.x.key],
      y: (row) => row[spec.y.key],
      label: (row) => row.name,
    }),
    [spec],
  )

  const lines = useMemo(
    () => [
      {
        id: 'trend',
        name: 'Trend',
        color: TREND_COLOR[mode],
        points: binnedMean(
          rows,
          (row) => row[spec.x.key],
          (row) => row[spec.y.key],
        ),
      },
    ],
    [rows, spec, mode],
  )

  // Axis specs are dependencies of the chart's base option, so they have to be
  // referentially stable — an inline literal would rebuild the chart on every
  // render.
  const xAxis = useMemo(
    () => ({ name: spec.x.label, unit: spec.x.unit }),
    [spec],
  )
  const yAxis = useMemo(
    () => ({ name: spec.y.label, unit: spec.y.unit }),
    [spec],
  )

  const handleSelect = useCallback(
    ({ ids, op, anchorId }: SelectionChange) =>
      apply(ids, op, { anchorId, source: 'chart' }),
    [apply],
  )

  const renderTooltip = useCallback(
    (row: DataPoint) =>
      [
        `<b>${row.name}</b>`,
        `${CATEGORY_LABEL[row.category]} · ${row.region} · ${row.status}`,
        `${spec.x.label} ${formatValue(row[spec.x.key], spec.x.unit)}`,
        `${spec.y.label} ${formatValue(row[spec.y.key], spec.y.unit)}`,
      ].join('<br/>'),
    [spec],
  )

  const visibleSelected = useMemo(() => {
    let count = 0
    for (const row of rows) if (selectedIds.has(row.id)) count++
    return count
  }, [rows, selectedIds])

  return (
    <figure className="chart-card">
      <figcaption className="chart-card__head">
        <h2 className="chart-card__title">{spec.title}</h2>
        <p className="chart-card__caption">
          {visibleSelected > 0
            ? `${formatCount(visibleSelected)} selected here`
            : spec.caption}
        </p>
      </figcaption>
      <ScatterSelectChart
        className="chart-card__canvas"
        series={series}
        accessors={accessors}
        lines={lines}
        x={xAxis}
        y={yAxis}
        chrome={chrome}
        selectedIds={selectedIds}
        onSelect={handleSelect}
        renderTooltip={renderTooltip}
      />
    </figure>
  )
}
