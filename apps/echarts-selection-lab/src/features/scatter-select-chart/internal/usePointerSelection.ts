/**
 * Wires pointer gestures on the canvas to `onSelect`.
 *
 * Two things here are worth reading closely, because both are the usual failure
 * modes of ECharts brush selection:
 *
 * 1. **The marquee never persists.** ECharts keeps the brush rectangle on
 *    screen after mouse-up and treats it as live state. That is not how
 *    selection works anywhere else — the rectangle is transient feedback, the
 *    *points* are the result. So on `brushEnd` we read the rectangle, resolve
 *    it to ids, then immediately clear all brush areas and re-arm the brush
 *    cursor. The user sees the box while dragging and nothing after releasing.
 *
 * 2. **The rectangle is read from the event, not from `brushSelected`.**
 *    `brushSelected` is throttled, so on a fast drag-and-release its last
 *    payload can be stale by the time `brushEnd` arrives. `brushEnd` carries
 *    `coordRange` — the rectangle already in data space — which we intersect
 *    against the model ourselves. No race, and no dependence on ECharts' notion
 *    of what is selected.
 */

import { useEffect, useRef, type RefObject } from 'react'
import type { ECharts } from './echarts'
import { armBrush, clearMarquee } from './brush'
import { nearestPoint, pointsInRect, type ChartModel } from './model'
import {
  modifiersOf,
  resolveCanvasClickOp,
  resolveCanvasOp,
  type ModifierState,
} from './resolveOp'
import type { SelectionChange } from '../types'

/** Below this drag distance the gesture is a click, not a marquee. */
const DRAG_THRESHOLD_PX = 4
/** Clicks within this many pixels of a dot hit it — a target bigger than the mark. */
const HIT_RADIUS_PX = 10

interface Gesture {
  active: boolean
  dragged: boolean
  startX: number
  startY: number
  modifiers: ModifierState
}

type BrushEndPayload = {
  areas?: { coordRange?: number[][]; range?: number[][] }[]
}

const NO_MODIFIERS: ModifierState = {
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
}

export function usePointerSelection(
  chart: ECharts | null,
  containerRef: RefObject<HTMLDivElement | null>,
  modelRef: RefObject<ChartModel<unknown> | null>,
  onSelect: (change: SelectionChange) => void,
) {
  const gestureRef = useRef<Gesture>({
    active: false,
    dragged: false,
    startX: 0,
    startY: 0,
    modifiers: NO_MODIFIERS,
  })

  // Latest-value ref: handlers are attached once and must not re-subscribe
  // every time the host re-renders with a new callback identity.
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  useEffect(() => {
    const container = containerRef.current
    if (!chart || !container) return

    const timers = new Set<ReturnType<typeof setTimeout>>()
    const emit = (change: SelectionChange) => onSelectRef.current(change)

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      gestureRef.current = {
        active: true,
        dragged: false,
        startX: event.clientX,
        startY: event.clientY,
        modifiers: modifiersOf(event),
      }
    }

    const onPointerMove = (event: PointerEvent) => {
      const gesture = gestureRef.current
      if (!gesture.active || gesture.dragged) return
      const dx = event.clientX - gesture.startX
      const dy = event.clientY - gesture.startY
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) gesture.dragged = true
    }

    const onPointerUp = (event: PointerEvent) => {
      const gesture = gestureRef.current
      if (!gesture.active) return
      gesture.active = false

      // A drag is resolved by `brushEnd`, which fires after pointerup. Leave
      // `dragged` set so that handler can tell the two gestures apart.
      if (gesture.dragged) return

      const model = modelRef.current
      if (!model) return

      const bounds = container.getBoundingClientRect()
      const px = event.clientX - bounds.left
      const py = event.clientY - bounds.top

      const at = chart.convertFromPixel({ gridIndex: 0 }, [px, py]) as number[]
      const edge = chart.convertFromPixel({ gridIndex: 0 }, [
        px + HIT_RADIUS_PX,
        py + HIT_RADIUS_PX,
      ]) as number[]
      if (!at || !edge) return

      const hit = nearestPoint(
        model.data,
        at[0],
        at[1],
        Math.abs(edge[0] - at[0]) || Number.EPSILON,
        Math.abs(edge[1] - at[1]) || Number.EPSILON,
      )
      const op = resolveCanvasClickOp(gesture.modifiers)

      if (hit) {
        emit({ ids: [hit], op, anchorId: hit })
      } else if (op === 'replace') {
        // Click on empty canvas clears, exactly like a desktop file manager.
        // A modifier-click on empty canvas is a no-op, not a wipe.
        emit({ ids: [], op: 'replace', anchorId: null })
      }
    }

    const onBrushEnd = (params: unknown) => {
      const gesture = gestureRef.current
      const wasDrag = gesture.dragged
      gesture.dragged = false

      const area = (params as BrushEndPayload).areas?.[0]
      const model = modelRef.current

      if (wasDrag && area && model) {
        const rect = toDataRect(chart, area)
        if (rect) {
          emit({
            ids: pointsInRect(model.data, rect),
            op: resolveCanvasOp(gesture.modifiers),
          })
        }
      }

      // Deferred so we are not dispatching an action from inside one. The chart
      // may be gone by then, hence the guard inside `clearMarquee`.
      timers.add(setTimeout(() => clearMarquee(chart), 0))
    }

    container.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    chart.on('brushEnd', onBrushEnd)
    armBrush(chart)

    return () => {
      container.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      chart.off('brushEnd', onBrushEnd)
      timers.forEach(clearTimeout)
    }
  }, [chart, containerRef, modelRef])
}

/**
 * `coordRange` is already in data space; `range` is pixels. Prefer the former
 * and fall back for the case where ECharts could not bind the brush to the grid.
 */
function toDataRect(
  chart: ECharts,
  area: { coordRange?: number[][]; range?: number[][] },
): [[number, number], [number, number]] | null {
  const coord = area.coordRange
  if (coord?.length === 2) {
    return [
      [coord[0][0], coord[0][1]],
      [coord[1][0], coord[1][1]],
    ]
  }

  const pixels = area.range
  if (pixels?.length !== 2) return null

  const a = chart.convertFromPixel({ gridIndex: 0 }, [
    pixels[0][0],
    pixels[1][0],
  ]) as number[]
  const b = chart.convertFromPixel({ gridIndex: 0 }, [
    pixels[0][1],
    pixels[1][1],
  ]) as number[]
  if (!a || !b) return null

  return [
    [a[0], b[0]],
    [a[1], b[1]],
  ]
}
