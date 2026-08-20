/**
 * Selection algebra — pure, no React, no ECharts, no DOM.
 *
 * `SelectionOp` is the shared vocabulary. The chart slice declares a
 * structurally identical union of its own (it has to, to stay portable), and
 * the two are assignable in both directions at zero cost.
 *
 * Note what is *not* here: the canvas modifier convention. It lives inside the
 * chart slice, because a scatter is an icon view and a table is a list view and
 * they genuinely disagree about what shift means. What they share is this
 * vocabulary and `applyOp`, which is the part that has to agree.
 */

export type SelectionOp = 'replace' | 'add' | 'subtract' | 'toggle'

/** Where a change came from. Only used to decide whether the table scrolls. */
export type SelectionSource = 'chart' | 'table' | 'system'

export interface ModifierState {
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/**
 * List-view convention, as in a file manager: shift extends a contiguous range
 * from the anchor, cmd/ctrl toggles one row.
 *
 * `range` is resolved by the caller via `expandRange`, because it needs the
 * visible row order and this function does not have it.
 */
export function resolveListOp(mod: ModifierState): SelectionOp | 'range' {
  if (mod.shiftKey) return 'range'
  if (mod.ctrlKey || mod.metaKey) return 'toggle'
  return 'replace'
}

/**
 * Apply an op to the current selection. Always returns a new Set, so identity
 * comparison is a valid change signal for React and for the chart patcher.
 */
export function applyOp(
  prev: ReadonlySet<string>,
  incoming: Iterable<string>,
  op: SelectionOp,
): Set<string> {
  if (op === 'replace') return new Set(incoming)

  const next = new Set(prev)
  for (const id of incoming) {
    switch (op) {
      case 'add':
        next.add(id)
        break
      case 'subtract':
        next.delete(id)
        break
      case 'toggle':
        if (next.has(id)) next.delete(id)
        else next.add(id)
        break
    }
  }
  return next
}

/**
 * The inclusive slice of `orderedIds` between anchor and target.
 *
 * `orderedIds` must be the order the user actually sees (post-filter,
 * post-sort) — shift-selecting against the raw dataset order would grab rows
 * that are not on screen.
 */
export function expandRange(
  orderedIds: readonly string[],
  anchorId: string | null,
  targetId: string,
): string[] {
  const to = orderedIds.indexOf(targetId)
  if (to === -1) return []

  const from = anchorId === null ? -1 : orderedIds.indexOf(anchorId)
  if (from === -1) return [targetId]

  const [lo, hi] = from <= to ? [from, to] : [to, from]
  return orderedIds.slice(lo, hi + 1)
}

/** Read modifier keys off any mouse/pointer/keyboard event. */
export function modifiersOf(event: ModifierState): ModifierState {
  return {
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
  }
}
