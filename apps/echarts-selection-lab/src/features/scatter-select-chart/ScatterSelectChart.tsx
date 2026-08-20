/**
 * A scatter plot with marquee + click selection, an optional overlaid line, and
 * automatic non-overlapping labels on the selected points.
 *
 * Fully controlled: it renders `selectedIds` and reports gestures through
 * `onSelect`. It owns no selection state, which is what lets two of these — or
 * one of these and a table — stay in sync without knowing about each other.
 */

import { useEffect, useMemo, useRef } from 'react'
import { useEchart } from './internal/useEchart'
import { usePointerSelection } from './internal/usePointerSelection'
import { armBrush } from './internal/brush'
import { buildModel, collectOverlay, type ChartModel } from './internal/model'
import { buildBaseOption, buildSelectionPatch } from './internal/option'
import { computeLabelPlacements } from './internal/labelLayout'
import type { ScatterSelectChartProps } from './types'

const NO_LINES: never[] = []
const DEFAULT_MAX_LABELLED_SELECTION = 2000

export function ScatterSelectChart<TRow>({
  series,
  accessors,
  lines = NO_LINES,
  x,
  y,
  chrome,
  selectedIds,
  onSelect,
  renderTooltip,
  maxLabelledSelection = DEFAULT_MAX_LABELLED_SELECTION,
  className,
  style,
}: ScatterSelectChartProps<TRow>) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const { chart, resizeToken } = useEchart(containerRef)

  const model = useMemo(
    () => buildModel(series, accessors, lines),
    [series, accessors, lines],
  )

  // Latest-value ref: the pointer handlers are attached once and must not
  // re-subscribe every time the host's data changes.
  const modelRef = useRef<ChartModel<TRow> | null>(null)
  modelRef.current = model

  const overlay = useMemo(() => collectOverlay(model, selectedIds), [model, selectedIds])

  // Structure: points, axes, brush config. Rebuilt only when the data changes.
  // A `notMerge` setOption drops the global cursor, so brush mode is re-armed
  // right after — otherwise dragging silently stops selecting after the first
  // data change.
  useEffect(() => {
    if (!chart) return
    chart.setOption(buildBaseOption(model, x, y, chrome, renderTooltip), {
      notMerge: true,
    })
    armBrush(chart)
    // `renderTooltip` is read through the option closure; treating it as a
    // dependency would rebuild the chart on every host render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, model, x, y, chrome])

  // Delta: dimming plus the selected overlay. Declared after the effect above
  // so a data rebuild is always followed by re-applying the current selection.
  //
  // Label placement runs here rather than in the pure builder because it needs
  // the live axis scales — which is also why `resizeToken` is a dependency.
  useEffect(() => {
    if (!chart) return
    const placements = computeLabelPlacements(
      chart,
      model as ChartModel<unknown>,
      overlay,
      maxLabelledSelection,
    )
    chart.setOption(
      buildSelectionPatch(
        model,
        selectedIds.size > 0,
        overlay,
        chrome,
        placements ?? undefined,
      ),
    )
  }, [chart, model, selectedIds, overlay, chrome, maxLabelledSelection, resizeToken])

  usePointerSelection(
    chart,
    containerRef,
    modelRef as React.RefObject<ChartModel<unknown> | null>,
    onSelect,
  )

  return <div ref={containerRef} className={className} style={style} />
}
