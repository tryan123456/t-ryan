/**
 * Query parameters. Kept separate from selection: they change for different
 * reasons, at different rates, and re-render different things.
 */

import { create } from 'zustand'
import { DEFAULT_QUERY } from './data/query'
import type { Query } from './types'

interface QueryState {
  query: Query
  patch: (partial: Partial<Query>) => void
  reset: () => void
}

export const useQueryStore = create<QueryState>((set) => ({
  query: DEFAULT_QUERY,
  patch: (partial) => set((state) => ({ query: { ...state.query, ...partial } })),
  reset: () => set({ query: DEFAULT_QUERY }),
}))

/** Toggle one value in a multi-select facet, never emptying it to nothing. */
export function toggleFacet<T>(current: T[], value: T): T[] {
  const next = current.includes(value)
    ? current.filter((v) => v !== value)
    : [...current, value]
  return next.length === 0 ? current : next
}
