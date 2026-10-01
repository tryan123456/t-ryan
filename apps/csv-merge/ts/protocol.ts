// Messages exchanged between the API thread, the job worker, and its
// index/render workers.

import type { ConflictKey, ConflictSummary, MergePolicy, MergeStats } from './types.ts'

export interface Header {
  rec: Uint8Array
  /** `[start, end]` pairs into `rec`. */
  fields: Int32Array
}

export interface IndexedFile {
  path: string
  alias: string
  bytes: number
  headers: Header[]
  /** 4 words per value column. */
  colHash: Uint32Array
  /** 4 words per row; capacity may exceed `rows`. */
  rowHash: Uint32Array
  /** Start offset of each data record (SharedArrayBuffer-backed). */
  rowOff: Float64Array
  rows: number
}

export interface IndexRequest {
  paths: string[]
  /** Indices into `paths` this worker should index, in order. */
  files: number[]
  m: number
  n: number
}

export type IndexResponse =
  | { type: 'indexed'; index: number; file: IndexedFile }
  | { type: 'error'; index: number; message: string }

export interface JobInit {
  files: string[]
  rowKeyCols: number
  colKeyRows: number
  threads: number
  aliases?: string[]
}

export type JobRequest =
  | { type: 'merge'; id: number; outPath: string; policy: MergePolicy }
  | { type: 'conflictKeys'; id: number; rows: boolean; offset: number; limit: number }

export type JobResponse =
  | { type: 'opened'; openMs: number; summary: ConflictSummary }
  | { type: 'openError'; message: string }
  | { type: 'result'; id: number; value: MergeStats | ConflictKey[] }
  | { type: 'failure'; id: number; message: string }

/** Everything a render worker needs; all arrays are SharedArrayBuffer-backed. */
export interface RenderInit {
  m: number
  paths: string[]
  bytes: number[]
  rows: number[]
  rowOff: Float64Array[]
  fileBase: Uint32Array
  rowStart: Uint32Array
  rowSrc: Uint32Array
  outCols: number
  srcStart: Uint32Array
  /** `[file, column]` pairs, grouped by output column in file order. */
  sources: Uint32Array
}

export type RenderRequest = { type: 'batch'; batch: number; from: number; to: number }

export type RenderResponse =
  | { type: 'ready' }
  | { type: 'rendered'; batch: number; buf: ArrayBuffer; len: number }
  | { type: 'error'; message: string }
