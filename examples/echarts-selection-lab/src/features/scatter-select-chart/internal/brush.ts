/**
 * Brush-mode plumbing, shared by the chart component and the pointer bridge.
 *
 * `armBrush` has to run more often than you'd expect: a `notMerge` setOption
 * (which is what a query change does) resets the global cursor, so without
 * re-arming, dragging silently stops selecting after the first filter change.
 */

import type { ECharts } from './echarts'

/** Put the chart into drag-to-marquee mode. Safe to call repeatedly. */
export function armBrush(chart: ECharts) {
  if (chart.isDisposed()) return
  chart.dispatchAction({
    type: 'takeGlobalCursor',
    key: 'brush',
    brushOption: { brushType: 'rect', brushMode: 'single' },
  })
}

/**
 * Erase the marquee rectangle and go straight back to brush mode.
 *
 * This is the whole fix for ECharts' sticky selection box: the rectangle is
 * feedback shown during the drag, and the moment the pointer is released the
 * result lives in the selection store instead.
 *
 * The brush *areas* and the brush *cursor* are independent bits of model state,
 * so the re-arm here is belt-and-braces rather than strictly required — it
 * costs one update per gesture and makes the invariant "brushing is always
 * available" hold no matter what else touched the option.
 */
export function clearMarquee(chart: ECharts) {
  if (chart.isDisposed()) return
  chart.dispatchAction({ type: 'brush', areas: [] })
  armBrush(chart)
}
