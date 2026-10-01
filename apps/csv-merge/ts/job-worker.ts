// Owns one merge job; mirrors Job in src/job.rs. Runs in its own worker so
// the calling thread (e.g. Electron's main process) never blocks.
//
// Rows are addressed by a global index `g = fileBase[file] + rowInFile`,
// which keeps every per-row structure at 4 bytes per entry.

import { closeSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'
import { parentPort, Worker, workerData } from 'node:worker_threads'

import { ByteBuilder, COMMA, Fields, LF, WindowReader, escaped, splitFields, trimEol, unquote } from './csv.ts'
import { fileOf, pairs } from './tables.ts'
import type {
  Header,
  IndexedFile,
  IndexRequest,
  IndexResponse,
  JobInit,
  JobRequest,
  JobResponse,
  RenderInit,
  RenderResponse,
} from './protocol.ts'
import type { ConflictKey, ConflictSummary, MergePolicy, MergeStats, PairConflict } from './types.ts'

const NONE = 0xffffffff
const MAX_FILES = 64
/** Target size of one rendered batch of output rows in pass 2. */
const BATCH_BYTES = 4 << 20
const WINDOW_PER_THREAD = 2

interface FileIndex {
  path: string
  /** Source name: the caller's alias, or the file stem by default. */
  alias: string
  bytes: number
  headers: Header[]
  /** Base column id (deduplicated across files) of each value column. */
  colBase: Uint32Array
  rowOff: Float64Array
  rows: number
}

interface Job {
  m: number
  n: number
  threads: number
  files: FileIndex[]
  fileBase: Uint32Array
  /** CSR: output row `o` is made of global rows `rowSrc[rowStart[o] .. rowStart[o + 1]]`, in file order. */
  rowStart: Uint32Array
  rowSrc: Uint32Array
  /** Bitmask (two 32-bit halves) of files that contain each base column. */
  colFilesLo: Uint32Array
  colFilesHi: Uint32Array
  /** Pairwise `F × F` counts of shared row keys / column keys. */
  rowOverlap: Float64Array
  colOverlap: Float64Array
  duplicateRows: number
  duplicateCols: number
  /** Output rows / base columns that take part in at least one conflict. */
  conflictRows: Uint32Array
  conflictCols: Uint32Array
  /** First `[file, value column]` of each base column, for its header text. */
  colFirst: Uint32Array
}

const shared32 = (len: number) => new Uint32Array(new SharedArrayBuffer(Math.max(1, len) * 4))
function writeAll(fd: number, buf: Uint8Array, len = buf.length) {
  for (let at = 0; at < len; ) at += writeSync(fd, buf, at, len - at)
}
const nextPow2 = (x: number) => 2 ** Math.ceil(Math.log2(Math.max(2, x)))

function post(msg: JobResponse) {
  parentPort!.postMessage(msg)
}

/** Pass 1 across worker threads; resolves with files in input order. */
async function indexAll(paths: string[], m: number, n: number, threads: number): Promise<IndexedFile[]> {
  const f = paths.length
  const perThread = Math.ceil(f / Math.min(Math.max(threads, 1), f))
  const results: IndexedFile[] = new Array(f)
  const workers: Worker[] = []
  try {
    await new Promise<void>((resolve, reject) => {
      let remaining = f
      for (let start = 0; start < f; start += perThread) {
        const w = new Worker(new URL('./index-worker.ts', import.meta.url))
        workers.push(w)
        w.on('error', reject)
        w.on('message', (msg: IndexResponse) => {
          if (msg.type === 'error') return reject(new Error(msg.message))
          results[msg.index] = msg.file
          if (--remaining === 0) resolve()
        })
        const files = Array.from({ length: Math.min(perThread, f - start) }, (_, i) => start + i)
        w.postMessage({ paths, files, m, n } satisfies IndexRequest)
      }
    })
  } finally {
    await Promise.all(workers.map((w) => w.terminate()))
  }
  return results
}

/**
 * Assigns output rows in first-appearance order with an open-addressing
 * table that stores only `g + 1` of each key's first row (0 = empty); the
 * hash itself is looked up in the per-file hash arrays. Sized like hashbrown:
 * next power of two ≥ total × 8/7. The table is freed when this returns.
 */
function assignRows(rowHashes: Uint32Array[], fileBase: Uint32Array, total: number) {
  const f = rowHashes.length
  const mask = nextPow2(Math.ceil((total * 8) / 7)) - 1
  const table = new Uint32Array(mask + 1)
  const rowOut = new Uint32Array(total)
  const lastFile = new Uint8Array(total)
  let outRows = 0
  let duplicateRows = 0
  for (let fi = 0; fi < f; fi++) {
    const H = rowHashes[fi]
    const base = fileBase[fi]
    const rows = fileBase[fi + 1] - base
    for (let ri = 0; ri < rows; ri++) {
      const g = base + ri
      const h0 = H[4 * ri]
      const h1 = H[4 * ri + 1]
      const h2 = H[4 * ri + 2]
      const h3 = H[4 * ri + 3]
      for (let i = h0 & mask; ; i = (i + 1) & mask) {
        const e: number = table[i]
        if (e === 0) {
          table[i] = g + 1
          rowOut[g] = outRows
          lastFile[outRows] = fi
          outRows++
          break
        }
        const g2: number = e - 1
        const f2 = fileOf(fileBase, g2)
        const H2 = rowHashes[f2]
        const k = 4 * (g2 - fileBase[f2])
        if (H2[k] === h0 && H2[k + 1] === h1 && H2[k + 2] === h2 && H2[k + 3] === h3) {
          const o = rowOut[g2]
          if (lastFile[o] === fi) {
            duplicateRows++
            rowOut[g] = NONE
          } else {
            lastFile[o] = fi
            rowOut[g] = o
          }
          break
        }
      }
    }
  }
  return { rowOut, outRows, duplicateRows }
}

/** Fills CSR sources from rowOut. Iterating g in order keeps each output row's sources in file order. */
function fillCsr(rowOut: Uint32Array, rowStart: Uint32Array): Uint32Array {
  const outRows = rowStart.length - 1
  const cursor = rowStart.slice()
  const rowSrc = shared32(rowStart[outRows])
  for (let g = 0; g < rowOut.length; g++) {
    const o = rowOut[g]
    if (o !== NONE) rowSrc[cursor[o]++] = g
  }
  return rowSrc
}

async function open(init: JobInit): Promise<Job> {
  const { files: paths, rowKeyCols: m, colKeyRows: n, threads, aliases } = init
  if (paths.length === 0 || paths.length > MAX_FILES) throw new Error(`expected 1..=${MAX_FILES} files`)
  if (n === 0) throw new Error('colKeyRows must be at least 1')
  const f = paths.length
  if (aliases) {
    if (aliases.length !== f) throw new Error(`aliases: expected ${f} entries, got ${aliases.length}`)
    aliases.forEach((a, i) => {
      if (a === '') throw new Error(`aliases[${i}] is empty`)
      if (aliases.indexOf(a) < i) throw new Error(`aliases[${i}] duplicates "${a}"`)
    })
  }

  const indexed = await indexAll(paths, m, n, threads)

  if (aliases) {
    indexed.forEach((x, i) => (x.alias = aliases[i]))
  } else {
    // Make default names unique so suffixed columns stay distinguishable.
    for (let i = 0; i < f; i++) {
      if (indexed.slice(0, i).some((o) => o.alias === indexed[i].alias)) indexed[i].alias = `${indexed[i].alias}#${i + 1}`
    }
  }

  const fileBase = shared32(f + 1)
  let total = 0
  for (let i = 0; i < f; i++) {
    fileBase[i] = total
    total += indexed[i].rows
  }
  if (total >= NONE) throw new Error(`too many rows (${total})`)
  fileBase[f] = total

  const rowHashes = indexed.map((x) => x.rowHash)
  const assigned = assignRows(rowHashes, fileBase, total)
  const { outRows, duplicateRows } = assigned
  let rowOut = assigned.rowOut
  for (const x of indexed) x.rowHash = new Uint32Array(0)
  rowHashes.length = 0

  // Invert rowOut into CSR.
  const rowStart = shared32(outRows + 1)
  for (let g = 0; g < total; g++) if (rowOut[g] !== NONE) rowStart[rowOut[g] + 1]++
  for (let i = 0; i < outRows; i++) rowStart[i + 1] += rowStart[i]
  const rowSrc = fillCsr(rowOut, rowStart)
  rowOut = new Uint32Array(0)

  const rowOverlap = new Float64Array(f * f)
  for (let o = 0; o < outRows; o++) {
    if (rowStart[o + 1] - rowStart[o] < 2) continue
    let lo = 0
    let hi = 0
    for (let k = rowStart[o]; k < rowStart[o + 1]; k++) {
      const fi = fileOf(fileBase, rowSrc[k])
      if (fi < 32) lo |= 1 << fi
      else hi |= 1 << (fi - 32)
    }
    pairs(lo, hi, f, (a, b) => rowOverlap[a * f + b]++)
  }

  // Global column table: same open-addressing scheme as rows, storing
  // `id + 1` and comparing against each base column's first hash.
  const totalCols = indexed.reduce((sum, x) => sum + x.colHash.length / 4, 0)
  const colMask = nextPow2(Math.ceil((totalCols * 8) / 7)) - 1
  const colTable = new Uint32Array(colMask + 1)
  const baseHash = new Uint32Array(totalCols * 4)
  const lo: number[] = []
  const hi: number[] = []
  const colFirst: number[] = []
  let duplicateCols = 0
  const colBases: Uint32Array[] = []
  for (let fi = 0; fi < f; fi++) {
    const H = indexed[fi].colHash
    const base = new Uint32Array(H.length / 4)
    const bit = fi < 32 ? 1 << fi : 1 << (fi - 32)
    const halves = fi < 32 ? lo : hi
    for (let j = 0; j < base.length; j++) {
      const h0 = H[4 * j]
      let id = -1
      for (let i = h0 & colMask; ; i = (i + 1) & colMask) {
        const e = colTable[i]
        if (e === 0) {
          id = lo.length
          colTable[i] = id + 1
          baseHash.set(H.subarray(4 * j, 4 * j + 4), 4 * id)
          lo.push(0)
          hi.push(0)
          colFirst.push(fi, j)
          break
        }
        const k = 4 * (e - 1)
        if (baseHash[k] === h0 && baseHash[k + 1] === H[4 * j + 1] && baseHash[k + 2] === H[4 * j + 2] && baseHash[k + 3] === H[4 * j + 3]) {
          id = e - 1
          break
        }
      }
      if (halves[id] & bit) duplicateCols++
      halves[id] |= bit
      base[j] = id
    }
    colBases.push(base)
  }
  const colOverlap = new Float64Array(f * f)
  for (let id = 0; id < lo.length; id++) {
    const ones = popcount(lo[id]) + popcount(hi[id])
    if (ones > 1) pairs(lo[id], hi[id], f, (a, b) => colOverlap[a * f + b]++)
  }

  // Keys that take part in a conflict. Only ids are kept; key text is
  // produced on request (columns from the headers, rows by re-reading).
  let conflictRows = new Uint32Array(outRows)
  let nRows = 0
  for (let o = 0; o < outRows; o++) {
    const a = rowStart[o]
    const b = rowStart[o + 1]
    if (b - a < 2) continue
    let mlo = 0
    let mhi = 0
    for (let k = a; k < b; k++) {
      const fi = fileOf(fileBase, rowSrc[k])
      if (fi < 32) mlo |= 1 << fi
      else mhi |= 1 << (fi - 32)
    }
    if (anyPair(mlo, mhi, f, colOverlap)) conflictRows[nRows++] = o
  }
  conflictRows = conflictRows.slice(0, nRows)
  const conflictCols: number[] = []
  for (let id = 0; id < lo.length; id++) {
    if (popcount(lo[id]) + popcount(hi[id]) > 1 && anyPair(lo[id], hi[id], f, rowOverlap)) conflictCols.push(id)
  }

  return {
    m,
    n,
    threads,
    files: indexed.map((x, i) => ({
      path: x.path,
      alias: x.alias,
      bytes: x.bytes,
      headers: x.headers,
      colBase: colBases[i],
      rowOff: x.rowOff,
      rows: x.rows,
    })),
    fileBase,
    rowStart,
    rowSrc,
    colFilesLo: Uint32Array.from(lo),
    colFilesHi: Uint32Array.from(hi),
    rowOverlap,
    colOverlap,
    duplicateRows,
    duplicateCols,
    conflictRows,
    conflictCols: Uint32Array.from(conflictCols),
    colFirst: Uint32Array.from(colFirst),
  }
}

function rowMaskOf(fileBase: Uint32Array, rowStart: Uint32Array, rowSrc: Uint32Array, o: number): [number, number] {
  let lo = 0
  let hi = 0
  for (let k = rowStart[o]; k < rowStart[o + 1]; k++) {
    const fi = fileOf(fileBase, rowSrc[k])
    if (fi < 32) lo |= 1 << fi
    else hi |= 1 << (fi - 32)
  }
  return [lo, hi]
}

/** Whether any pair of files in the mask has `overlap > 0`; allocation-free. */
function anyPair(lo: number, hi: number, f: number, overlap: Float64Array): boolean {
  for (let a = 0; a < f; a++) {
    if (((a < 32 ? lo >>> a : hi >>> (a - 32)) & 1) === 0) continue
    for (let b = a + 1; b < f; b++) {
      if (((b < 32 ? lo >>> b : hi >>> (b - 32)) & 1) === 1 && overlap[a * f + b] > 0) return true
    }
  }
  return false
}

/**
 * Files in the mask that share at least one key of the other dimension with
 * another file in the mask (per `overlap`), i.e. the files a key conflicts across.
 */
function participants(lo: number, hi: number, f: number, overlap: Float64Array): number[] {
  const hit = new Uint8Array(f)
  pairs(lo, hi, f, (a, b) => {
    if (overlap[a * f + b] > 0) hit[a] = hit[b] = 1
  })
  const out: number[] = []
  hit.forEach((h, i) => h && out.push(i))
  return out
}

/** UTF-8 decode; invalid sequences become U+FFFD, like Rust's from_utf8_lossy. */
const text = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('utf8')

/** Conflicting column keys `[offset, offset + limit)`, in output order. */
function conflictCols(job: Job, offset: number, limit: number): ConflictKey[] {
  const f = job.files.length
  const out: ConflictKey[] = []
  const end = Math.min(offset + limit, job.conflictCols.length)
  for (let i = offset; i < end; i++) {
    const bid = job.conflictCols[i]
    const file = job.files[job.colFirst[2 * bid]]
    const j = job.m + job.colFirst[2 * bid + 1]
    out.push({
      key: file.headers.map((h) => text(unquote(h.rec, h.fields[2 * j], h.fields[2 * j + 1]))),
      sources: participants(job.colFilesLo[bid], job.colFilesHi[bid], f, job.rowOverlap).map((x) => job.files[x].alias),
    })
  }
  return out
}

/** Conflicting row keys `[offset, offset + limit)`, in output order. Key text is re-read from the first file containing each row. */
function conflictRows(job: Job, offset: number, limit: number): ConflictKey[] {
  const f = job.files.length
  const readers: (WindowReader | undefined)[] = new Array(f)
  const fds: number[] = []
  const fields = new Fields()
  const out: ConflictKey[] = []
  try {
    const end = Math.min(offset + limit, job.conflictRows.length)
    for (let i = offset; i < end; i++) {
      const o = job.conflictRows[i]
      const g = job.rowSrc[job.rowStart[o]]
      const fi = fileOf(job.fileBase, g)
      const file = job.files[fi]
      const ri = g - job.fileBase[fi]
      const off = file.rowOff[ri]
      const span = (ri + 1 < file.rows ? file.rowOff[ri + 1] : file.bytes) - off
      let r = readers[fi]
      if (!r) {
        const fd = openSync(file.path, 'r')
        fds.push(fd)
        r = readers[fi] = new WindowReader(fd, 64 << 10)
      }
      const s = r.read(off, span)
      splitFields(r.buf, s, trimEol(r.buf, s, s + span), job.m, fields)
      const key: string[] = []
      for (let k = 0; k < job.m; k++) key.push(k < fields.n ? text(unquote(r.buf, fields.start(k), fields.end(k))) : '')
      const [mlo, mhi] = rowMaskOf(job.fileBase, job.rowStart, job.rowSrc, o)
      out.push({ key, sources: participants(mlo, mhi, f, job.colOverlap).map((x) => job.files[x].alias) })
    }
  } finally {
    for (const fd of fds) closeSync(fd)
  }
  return out
}

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) & 0xff
}

const outRowsOf = (job: Job) => job.rowStart.length - 1

/** A cell conflicts when both its row key and column key exist in two files, so per file pair the conflicting cells are rows∩ × cols∩. */
function summarize(job: Job): ConflictSummary {
  const f = job.files.length
  const conflicts: PairConflict[] = []
  for (let a = 0; a < f; a++) {
    for (let b = a + 1; b < f; b++) {
      const rows = job.rowOverlap[a * f + b]
      const cols = job.colOverlap[a * f + b]
      if (rows > 0 && cols > 0) conflicts.push({ a, b, rows, cols, cells: rows * cols })
    }
  }
  return {
    totalCells: conflicts.reduce((s, p) => s + p.cells, 0),
    pairs: conflicts,
    files: job.files.map((x) => ({ path: x.path, alias: x.alias, bytes: x.bytes, rows: x.rows, valueCols: x.colBase.length })),
    outRows: outRowsOf(job),
    outValueCols: job.colFilesLo.length,
    duplicateRowKeys: job.duplicateRows,
    duplicateColKeys: job.duplicateCols,
    conflictRows: job.conflictRows.length,
    conflictCols: job.conflictCols.length,
  }
}

interface Layout {
  ocFile: number[]
  ocCol: number[]
  ocSuffixed: boolean[]
  srcStart: Uint32Array
  sources: Uint32Array
}

/** Output column layout, in first-appearance order. Under keepAll a column that conflicts with an earlier file gets its own suffixed copy. */
function layout(job: Job, policy: MergePolicy): Layout {
  const f = job.files.length
  const hasFile = (bid: number, g: number) =>
    ((g < 32 ? job.colFilesLo[bid] >>> g : job.colFilesHi[bid] >>> (g - 32)) & 1) === 1
  const ocFile: number[] = []
  const ocCol: number[] = []
  const ocSuffixed: boolean[] = []
  const baseOut = new Uint32Array(job.colFilesLo.length).fill(NONE)
  const colMap: Uint32Array[] = []
  for (let fi = 0; fi < f; fi++) {
    const colBase = job.files[fi].colBase
    const map = new Uint32Array(colBase.length)
    for (let j = 0; j < colBase.length; j++) {
      const bid = colBase[j]
      let conflicts = false
      if (policy === 'keepAll' && baseOut[bid] !== NONE) {
        for (let g = 0; g < fi && !conflicts; g++) conflicts = hasFile(bid, g) && job.rowOverlap[g * f + fi] > 0
      }
      if (baseOut[bid] === NONE || conflicts) {
        ocFile.push(fi)
        ocCol.push(j)
        ocSuffixed.push(conflicts)
        const id = ocFile.length - 1
        if (baseOut[bid] === NONE) baseOut[bid] = id
        map[j] = id
      } else {
        map[j] = baseOut[bid]
      }
    }
    colMap.push(map)
  }

  // Invert to: output column → contributing (file, column), in file order.
  const outCols = ocFile.length
  const srcStart = shared32(outCols + 1)
  for (const map of colMap) for (const c of map) srcStart[c + 1]++
  for (let i = 0; i < outCols; i++) srcStart[i + 1] += srcStart[i]
  const fill = srcStart.slice()
  const sources = shared32(srcStart[outCols] * 2)
  colMap.forEach((map, fi) => {
    map.forEach((c, j) => {
      const at = fill[c]++
      sources[2 * at] = fi
      sources[2 * at + 1] = job.m + j
    })
  })
  return { ocFile, ocCol, ocSuffixed, srcStart, sources }
}

function header(job: Job, lay: Layout): ByteBuilder {
  const { m, n } = job
  const out = new ByteBuilder(1 << 16)
  const raw = (h: Header, k: number) => h.rec.subarray(h.fields[2 * k], h.fields[2 * k + 1])
  const put = (b: Uint8Array) => {
    out.ensure(b.length)
    out.bytes(b, 0, b.length)
  }
  const suffix = job.files.map((x) => Buffer.from('@' + x.alias))
  for (let level = 0; level < n; level++) {
    const corner = job.files[0].headers[level]
    for (let k = 0; k < m; k++) {
      out.ensure(1)
      if (k > 0) out.byte(COMMA)
      put(raw(corner, k))
    }
    for (let c = 0; c < lay.ocFile.length; c++) {
      const file = job.files[lay.ocFile[c]]
      const hd = file.headers[level]
      const r = raw(hd, m + lay.ocCol[c])
      out.ensure(1)
      out.byte(COMMA)
      if (lay.ocSuffixed[c] && level === n - 1) {
        const v = unquote(r, 0, r.length)
        put(escaped(Buffer.concat([v, suffix[lay.ocFile[c]]])))
      } else {
        put(r)
      }
    }
    out.ensure(1)
    out.byte(LF)
  }
  return out
}

/** Splits output rows into contiguous batches of roughly BATCH_BYTES of output, estimated from source record sizes. */
function batches(job: Job, outCols: number): number[] {
  const bounds = [0]
  let acc = 0
  const outRows = outRowsOf(job)
  for (let o = 0; o < outRows; o++) {
    acc += outCols
    for (let k = job.rowStart[o]; k < job.rowStart[o + 1]; k++) {
      const g = job.rowSrc[k]
      const fi = fileOf(job.fileBase, g)
      const file = job.files[fi]
      const ri = g - job.fileBase[fi]
      acc += (ri + 1 < file.rows ? file.rowOff[ri + 1] : file.bytes) - file.rowOff[ri]
    }
    if (acc >= BATCH_BYTES) {
      bounds.push(o + 1)
      acc = 0
    }
  }
  if (bounds[bounds.length - 1] !== outRows) bounds.push(outRows)
  return bounds
}

/**
 * Pass 2. Render workers produce batches of rows in parallel; this thread
 * writes them in order. At most WINDOW_PER_THREAD × threads batches are
 * dispatched ahead of the writer, which bounds memory regardless of output size.
 */
async function writeOutput(job: Job, path: string, lay: Layout): Promise<number> {
  const fd = openSync(path, 'w')
  const workers: Worker[] = []
  try {
    const head = header(job, lay)
    writeAll(fd, head.buf, head.len)
    let written = head.len

    const bounds = batches(job, lay.ocFile.length)
    const total = bounds.length - 1
    const threads = Math.min(Math.max(job.threads, 1), Math.max(total, 1))
    const window = threads * WINDOW_PER_THREAD
    if (total === 0) return written

    const init: RenderInit = {
      m: job.m,
      paths: job.files.map((x) => x.path),
      bytes: job.files.map((x) => x.bytes),
      rows: job.files.map((x) => x.rows),
      rowOff: job.files.map((x) => x.rowOff),
      fileBase: job.fileBase,
      rowStart: job.rowStart,
      rowSrc: job.rowSrc,
      outCols: lay.ocFile.length,
      srcStart: lay.srcStart,
      sources: lay.sources,
    }

    await new Promise<void>((resolve, reject) => {
      let nextBatch = 0
      let nextWrite = 0
      const pending = new Map<number, Uint8Array>()
      const idle: Worker[] = []
      const dispatch = (w: Worker) => {
        if (nextBatch < total && nextBatch < nextWrite + window) {
          const b = nextBatch++
          w.postMessage({ type: 'batch', batch: b, from: bounds[b], to: bounds[b + 1] })
        } else {
          idle.push(w)
        }
      }
      for (let i = 0; i < threads; i++) {
        const w = new Worker(new URL('./render-worker.ts', import.meta.url), { workerData: init })
        workers.push(w)
        w.on('error', reject)
        w.on('message', (msg: RenderResponse) => {
          if (msg.type === 'error') return reject(new Error(msg.message))
          if (msg.type === 'rendered') {
            pending.set(msg.batch, new Uint8Array(msg.buf, 0, msg.len))
            try {
              for (let buf = pending.get(nextWrite); buf; buf = pending.get(nextWrite)) {
                pending.delete(nextWrite)
                writeAll(fd, buf)
                written += buf.length
                nextWrite++
              }
            } catch (e) {
              return reject(e)
            }
            if (nextWrite === total) return resolve()
            // Window space may have opened up for idle workers too.
            for (const w2 of idle.splice(0)) dispatch(w2)
          }
          dispatch(w)
        })
      }
    })
    return written
  } finally {
    await Promise.all(workers.map((w) => w.terminate()))
    closeSync(fd)
  }
}

async function merge(job: Job, outPath: string, policy: MergePolicy): Promise<MergeStats> {
  const t0 = performance.now()
  const lay = layout(job, policy)
  const tmp = `${outPath}.partial`
  try {
    const bytesWritten = await writeOutput(job, tmp, lay)
    renameSync(tmp, outPath)
    return { rows: outRowsOf(job), cols: job.m + lay.ocFile.length, bytesWritten, elapsedMs: performance.now() - t0 }
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

const init = workerData as JobInit
const t0 = performance.now()
try {
  const job = await open(init)
  post({ type: 'opened', openMs: performance.now() - t0, summary: summarize(job) })
  parentPort!.on('message', async (req: JobRequest) => {
    try {
      const value =
        req.type === 'merge'
          ? await merge(job, req.outPath, req.policy)
          : req.rows
            ? conflictRows(job, req.offset, req.limit)
            : conflictCols(job, req.offset, req.limit)
      post({ type: 'result', id: req.id, value })
    } catch (e) {
      post({ type: 'failure', id: req.id, message: (e as Error).message })
    }
  })
} catch (e) {
  // The API thread terminates this worker after reading the error.
  post({ type: 'openError', message: (e as Error).message })
}
