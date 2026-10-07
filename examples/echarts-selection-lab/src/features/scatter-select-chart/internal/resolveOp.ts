/**
 * Canvas modifier semantics.
 *
 * A scatter plot is an icon view, not a list view: there is no meaningful
 * "range" between two points in 2D, so shift adds rather than extending. That
 * matches Finder's icon view and every design tool's canvas.
 *
 * A host that also has a list view (a table of the same rows) owns the list
 * convention itself — shift there means a contiguous range, which needs the
 * visible row order and so cannot be decided from here.
 */

import type { SelectionOp } from '../types'

export interface ModifierState {
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export function resolveCanvasOp(mod: ModifierState): SelectionOp {
  if (mod.altKey) return 'subtract'
  if (mod.shiftKey || mod.ctrlKey || mod.metaKey) return 'add'
  return 'replace'
}

/** Click on a point: same as above, except a modifier-less click on an
 * already-selected point should still collapse the selection to it. */
export function resolveCanvasClickOp(mod: ModifierState): SelectionOp {
  if (mod.altKey) return 'subtract'
  if (mod.ctrlKey || mod.metaKey) return 'toggle'
  if (mod.shiftKey) return 'add'
  return 'replace'
}

export function modifiersOf(event: ModifierState): ModifierState {
  return {
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
  }
}
