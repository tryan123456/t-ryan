/**
 * Owns one ECharts instance's lifecycle: create, resize, dispose.
 *
 * Nothing about *this* app lives here — no selection, no brush. Keeping the
 * imperative lifecycle separate from the interaction logic is what lets
 * `ScatterTrendChart` stay readable.
 */

import { useEffect, useRef, useState, type RefObject } from 'react'
import { echarts, type ECharts } from './echarts'

export function useEchart(containerRef: RefObject<HTMLDivElement | null>) {
  const [chart, setChart] = useState<ECharts | null>(null)
  const chartRef = useRef<ECharts | null>(null)
  /**
   * Bumped on every resize. Anything derived from pixel geometry — label
   * placement in particular — has to be recomputed when the plot changes size,
   * and this is the signal it depends on.
   */
  const [resizeToken, setResizeToken] = useState(0)

  useEffect(() => {
    const element = containerRef.current
    if (!element) return

    const instance = echarts.init(element, undefined, { renderer: 'canvas' })
    chartRef.current = instance
    setChart(instance)

    const observer = new ResizeObserver(() => {
      instance.resize()
      setResizeToken((token) => token + 1)
    })
    observer.observe(element)

    return () => {
      observer.disconnect()
      instance.dispose()
      chartRef.current = null
      setChart(null)
    }
  }, [containerRef])

  return { chart, chartRef, resizeToken }
}
