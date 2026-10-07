// Pass 1 for a set of files; mirrors index_file in src/job.rs.
//
// Row offsets go into SharedArrayBuffers because pass-2 render workers read
// them too; row and column hashes are transferred to the job worker, which
// drops them once the global tables are built.

import { closeSync, fstatSync, openSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { parentPort } from 'node:worker_threads'

import { Fields, KeyHasher, RecordReader, splitFields } from './csv.ts'
import type { IndexedFile, IndexRequest, IndexResponse } from './protocol.ts'

const READ_BUF = 4 << 20
const SAMPLE = 4096

class InvalidData extends Error {}

function sharedF64(len: number): Float64Array {
  return new Float64Array(new SharedArrayBuffer(Math.max(1, len) * 8))
}

function indexFile(path: string, m: number, n: number): { file: IndexedFile; transfer: ArrayBuffer[] } {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`)
  }
  try {
    const bytes = fstatSync(fd).size
    const reader = new RecordReader(fd, READ_BUF)
    const fields = new Fields()

    const headers: { rec: Uint8Array; fields: Int32Array }[] = []
    for (let level = 0; level < n; level++) {
      if (!reader.next()) throw new InvalidData(`${path}: expected ${n} header rows`)
      let s = reader.recStart
      const e = reader.recEnd
      const b = reader.buf
      if (reader.recOffset === 0 && e - s >= 3 && b[s] === 0xef && b[s + 1] === 0xbb && b[s + 2] === 0xbf) s += 3
      const rec = Uint8Array.from(b.subarray(s, e))
      splitFields(rec, 0, rec.length, Infinity, fields)
      if (level > 0 && fields.n * 2 !== headers[0].fields.length) {
        throw new InvalidData(`${path}: header row ${level} has a different column count`)
      }
      headers.push({ rec, fields: fields.r.slice(0, fields.n * 2) })
    }
    const ncols = headers[0].fields.length / 2
    if (ncols <= m) throw new InvalidData(`${path}: no value columns after ${m} key columns`)

    const hasher = new KeyHasher()
    const colHash = new Uint32Array((ncols - m) * 4)
    for (let j = m; j < ncols; j++) {
      hasher.reset()
      for (const hd of headers) hasher.part(hd.rec, hd.fields[2 * j], hd.fields[2 * j + 1])
      hasher.finish(colHash, (j - m) * 4)
    }

    let cap = SAMPLE + 1
    let rowHash = new Uint32Array(cap * 4)
    let rowOff = sharedF64(cap)
    let rows = 0
    const grow = (to: number) => {
      const h = new Uint32Array(to * 4)
      h.set(rowHash.subarray(0, rows * 4))
      rowHash = h
      const o = sharedF64(to)
      o.set(rowOff.subarray(0, rows))
      rowOff = o
      cap = to
    }

    while (reader.next()) {
      const { buf, recStart, recEnd, recOffset } = reader
      if (recStart === recEnd) continue
      // Size the arrays once from the average row length instead of letting
      // them double, which would briefly hold old + new buffers.
      if (rows === SAMPLE) {
        const avg = Math.max(1, Math.floor((recOffset - rowOff[0]) / SAMPLE))
        const estimate = Math.floor((bytes - rowOff[0]) / avg)
        grow(Math.max(rows + 1, estimate + Math.floor(estimate / 32)))
      } else if (rows === cap) {
        grow(Math.ceil(cap * 1.5))
      }
      splitFields(buf, recStart, recEnd, m, fields)
      hasher.reset()
      for (let k = 0; k < fields.n; k++) hasher.part(buf, fields.start(k), fields.end(k))
      hasher.finish(rowHash, rows * 4)
      rowOff[rows] = recOffset
      rows++
    }

    const file: IndexedFile = {
      path,
      alias: basename(path, extname(path)),
      bytes,
      headers,
      colHash,
      rowHash,
      rowOff,
      rows,
    }
    return { file, transfer: [colHash.buffer, rowHash.buffer as ArrayBuffer] }
  } finally {
    closeSync(fd)
  }
}

parentPort!.on('message', (req: IndexRequest) => {
  for (const i of req.files) {
    let msg: IndexResponse
    let transfer: ArrayBuffer[] = []
    try {
      const r = indexFile(req.paths[i], req.m, req.n)
      msg = { type: 'indexed', index: i, file: r.file }
      transfer = r.transfer
    } catch (e) {
      msg = { type: 'error', index: i, message: (e as Error).message }
    }
    parentPort!.postMessage(msg, transfer)
  }
})
