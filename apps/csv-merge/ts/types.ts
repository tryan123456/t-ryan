// Public types; mirror the napi-generated index.d.ts.

export interface OpenOptions {
  /** Leading columns that form the composite row key. */
  rowKeyCols: number
  /** Leading rows that form the composite column key. */
  colKeyRows: number
  /** Worker threads for both passes. Defaults to min(cores, 8). */
  threads?: number
  /**
   * One name per file, used as the `@<alias>` suffix under `keepAll` and as
   * the source name in conflict reports. Must be unique and non-empty.
   * Defaults to the file name without extension (`#<n>` added on clashes).
   */
  aliases?: string[]
}

export interface FileInfo {
  path: string
  alias: string
  bytes: number
  rows: number
  valueCols: number
}

export interface PairConflict {
  /** Index into `files`; `a < b`. */
  a: number
  b: number
  rows: number
  cols: number
  cells: number
}

export interface ConflictSummary {
  totalCells: number
  pairs: PairConflict[]
  files: FileInfo[]
  /** Output size before any `keepAll` suffix columns. */
  outRows: number
  outValueCols: number
  /** Repeated keys inside a single file; the first occurrence is used. */
  duplicateRowKeys: number
  duplicateColKeys: number
  /** Number of row / column keys that take part in a conflict; page through them with `conflictRows` / `conflictCols`. */
  conflictRows: number
  conflictCols: number
}

/** A conflicting row or column key. Cell `(r, c)` conflicts across `r.sources ∩ c.sources` (when that has at least two entries). */
export interface ConflictKey {
  /** The composite key, unquoted. */
  key: string[]
  /** Aliases of the files this key conflicts across, in file order. */
  sources: string[]
}

export interface MergeStats {
  rows: number
  cols: number
  bytesWritten: number
  elapsedMs: number
}

export type MergePolicy = 'overwrite' | 'keepAll'
