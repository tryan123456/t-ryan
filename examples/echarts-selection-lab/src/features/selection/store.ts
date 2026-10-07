/**
 * The single source of truth for "what is selected".
 *
 * Neither the chart slice nor the table keeps selection state of their own —
 * not ECharts' built-in `select`, not TanStack Table's `rowSelectionFeature`.
 * Both would be a second copy that has to be reconciled, and reconciliation is
 * where the sync bugs live. Every surface is a pure function of this store, and
 * every interaction is one call to `apply`.
 */

import { create } from 'zustand'
import { applyOp, type SelectionOp, type SelectionSource } from './algebra'

interface ApplyOptions {
  /**
   * The row that becomes the new anchor for a subsequent shift-range. Omit to
   * leave the anchor untouched (a marquee has no single origin row).
   */
  anchorId?: string | null
  source?: SelectionSource
}

interface SelectionState {
  ids: ReadonlySet<string>
  anchorId: string | null
  /**
   * Which surface caused the last change. The table uses this to decide whether
   * to scroll a selected row into view — it must not yank itself around in
   * response to its own clicks.
   */
  source: SelectionSource
  /** Bumped on every change, so effects can fire even when the Set is equal. */
  revision: number

  apply: (incoming: Iterable<string>, op: SelectionOp, options?: ApplyOptions) => void
  clear: (source?: SelectionSource) => void
}

const EMPTY: ReadonlySet<string> = new Set()

export const useSelectionStore = create<SelectionState>((set, get) => ({
  ids: EMPTY,
  anchorId: null,
  source: 'system',
  revision: 0,

  apply: (incoming, op, options = {}) => {
    const { ids, anchorId, revision } = get()
    set({
      ids: applyOp(ids, incoming, op),
      anchorId: options.anchorId === undefined ? anchorId : options.anchorId,
      source: options.source ?? 'system',
      revision: revision + 1,
    })
  },

  clear: (source = 'system') =>
    set((state) => ({
      ids: EMPTY,
      anchorId: null,
      source,
      revision: state.revision + 1,
    })),
}))
