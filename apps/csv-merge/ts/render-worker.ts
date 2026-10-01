// Pass 2 worker: renders batches of output rows; mirrors render_row in
// src/job.rs. The job worker writes the batches out in order.

import { openSync } from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'

import { ByteBuilder, COMMA, Fields, LF, WindowReader, isEmpty, splitFields, trimEol } from './csv.ts'
import { fileOf } from './tables.ts'
import type { RenderInit, RenderRequest, RenderResponse } from './protocol.ts'

const BATCH_BYTES = 4 << 20

const init = workerData as RenderInit
const f = init.paths.length
const readers = init.paths.map((p) => new WindowReader(openSync(p, 'r'), 256 << 10))
const fields = Array.from({ length: f }, () => new Fields())
const present = new Uint8Array(f)
const { m, fileBase, rowStart, rowSrc, rowOff, rows, bytes, outCols, srcStart, sources } = init

function renderRow(o: number, out: ByteBuilder) {
  present.fill(0)
  let budget = outCols + 1
  for (let k = rowStart[o]; k < rowStart[o + 1]; k++) {
    const g = rowSrc[k]
    const fi = fileOf(fileBase, g)
    const ri = g - fileBase[fi]
    const off = rowOff[fi][ri]
    const span = (ri + 1 < rows[fi] ? rowOff[fi][ri + 1] : bytes[fi]) - off
    const r = readers[fi]
    const s = r.read(off, span)
    splitFields(r.buf, s, trimEol(r.buf, s, s + span), Infinity, fields[fi])
    present[fi] = 1
    budget += span
  }
  // Output is at most the source bytes plus one comma per column.
  out.ensure(budget)

  const kf = fileOf(fileBase, rowSrc[rowStart[o]])
  const kb = readers[kf].buf
  for (let k = 0; k < m; k++) {
    if (k > 0) out.byte(COMMA)
    if (k < fields[kf].n) out.bytes(kb, fields[kf].start(k), fields[kf].end(k))
  }
  for (let c = 0; c < outCols; c++) {
    out.byte(COMMA)
    // Latest file wins; an empty cell never overwrites a value.
    for (let k = srcStart[c + 1] - 1; k >= srcStart[c]; k--) {
      const sf = sources[2 * k]
      const sc = sources[2 * k + 1]
      if (!present[sf] || sc >= fields[sf].n) continue
      const b = readers[sf].buf
      const s = fields[sf].start(sc)
      const e = fields[sf].end(sc)
      if (!isEmpty(b, s, e)) {
        out.bytes(b, s, e)
        break
      }
    }
  }
  out.byte(LF)
}

parentPort!.on('message', (req: RenderRequest) => {
  let msg: RenderResponse
  const transfer: ArrayBuffer[] = []
  try {
    const out = new ByteBuilder(BATCH_BYTES + BATCH_BYTES / 4)
    for (let o = req.from; o < req.to; o++) renderRow(o, out)
    msg = { type: 'rendered', batch: req.batch, buf: out.buf.buffer as ArrayBuffer, len: out.len }
    transfer.push(msg.buf)
  } catch (e) {
    msg = { type: 'error', message: (e as Error).message }
  }
  parentPort!.postMessage(msg, transfer)
})
parentPort!.postMessage({ type: 'ready' } satisfies RenderResponse)
