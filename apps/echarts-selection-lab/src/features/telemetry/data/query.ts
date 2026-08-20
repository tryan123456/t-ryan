/**
 * The query engine — a pure function over the immutable dataset.
 *
 * Charts and table both render the *same* array returned from here. That is
 * what makes "the selection is in sync" cheap: there is one row list, one id
 * order, one set of visible ids.
 */

import { CATEGORIES, REGIONS, STATUSES, type DataPoint, type Query } from '../types'

export const DEFAULT_QUERY: Query = {
  search: '',
  categories: [...CATEGORIES],
  regions: [...REGIONS],
  statuses: [...STATUSES],
  latencyRange: [0, 600],
  limit: 2000,
}

export interface QueryResult {
  rows: DataPoint[]
  /** Rows matching the predicate before `limit` was applied. */
  matched: number
  total: number
}

export function runQuery(dataset: readonly DataPoint[], query: Query): QueryResult {
  const search = query.search.trim().toLowerCase()
  const categories = new Set(query.categories)
  const regions = new Set(query.regions)
  const statuses = new Set(query.statuses)
  const [minLatency, maxLatency] = query.latencyRange

  const rows: DataPoint[] = []
  let matched = 0

  for (const row of dataset) {
    if (!categories.has(row.category)) continue
    if (!regions.has(row.region)) continue
    if (!statuses.has(row.status)) continue
    if (row.latencyMs < minLatency || row.latencyMs > maxLatency) continue
    if (search && !row.name.includes(search) && !row.id.includes(search)) continue

    matched++
    if (rows.length < query.limit) rows.push(row)
  }

  return { rows, matched, total: dataset.length }
}
