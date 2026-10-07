/**
 * The only place ECharts is registered.
 *
 * Importing the `echarts` barrel pulls in every chart type and component
 * (~1.4 MB). We use four things, so we register four things and import from
 * here everywhere else.
 */

import * as echarts from 'echarts/core'
import { LineChart, ScatterChart } from 'echarts/charts'
import { BrushComponent, GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  ScatterChart,
  LineChart,
  GridComponent,
  TooltipComponent,
  BrushComponent,
  CanvasRenderer,
])

export { echarts }
export type { ECharts } from 'echarts/core'
export type { EChartsOption } from 'echarts'
