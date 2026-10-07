// Straightforward in-memory implementation of the merge semantics, used as
// the oracle for the Rust implementation on small inputs.
import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'

/** Splits CSV text into records of raw (still-quoted) fields. */
export function parseRaw(text) {
  if (text.startsWith('﻿')) text = text.slice(1)
  const records = []
  let fields = []
  let start = 0
  let inQuote = false
  const endRecord = (i) => {
    let end = i
    while (end > start && text[end - 1] === '\r') end--
    fields.push(text.slice(start, end))
    if (!(fields.length === 1 && fields[0] === '')) records.push(fields)
    fields = []
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') inQuote = !inQuote
    else if (!inQuote && c === ',') {
      fields.push(text.slice(start, i))
      start = i + 1
    } else if (!inQuote && c === '\n') {
      endRecord(i)
      start = i + 1
    }
  }
  if (start < text.length || fields.length > 0) endRecord(text.length)
  return records
}

export const unquote = (raw) =>
  raw.length >= 2 && raw[0] === '"' && raw.at(-1) === '"' ? raw.slice(1, -1).replaceAll('""', '"') : raw
const isEmpty = (raw) => raw === '' || raw === '""'
const escape = (v) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v)

/** Builds the merge model shared by `referenceMerge` and `referenceConflicts`. */
function model(paths, { rowKeyCols: m, colKeyRows: n, aliases }) {
  const files = paths.map((p, i) => {
    const recs = parseRaw(readFileSync(p, 'utf8'))
    return { headers: recs.slice(0, n), rows: recs.slice(n), label: aliases?.[i] ?? basename(p, extname(p)), i }
  })
  if (!aliases) {
    files.forEach((f, i) => {
      if (files.slice(0, i).some((o) => o.label === f.label)) f.label = `${f.label}#${i + 1}`
    })
  }
  const F = files.length

  const rowIds = new Map()
  const slots = []
  files.forEach((f, fi) => {
    f.rows.forEach((r, ri) => {
      const key = JSON.stringify(r.slice(0, m).map(unquote))
      if (!rowIds.has(key)) {
        rowIds.set(key, slots.length)
        slots.push(new Array(F).fill(-1))
      }
      const s = slots[rowIds.get(key)]
      if (s[fi] === -1) s[fi] = ri
    })
  })
  const rowOverlap = (g, f) => slots.some((s) => s[g] !== -1 && s[f] !== -1)

  const colIds = new Map()
  const colFiles = []
  const colBase = files.map((f) =>
    f.headers[0].slice(m).map((_, j) => {
      const key = JSON.stringify(f.headers.map((h) => unquote(h[m + j])))
      if (!colIds.has(key)) {
        colIds.set(key, colFiles.length)
        colFiles.push(new Set())
      }
      const id = colIds.get(key)
      colFiles[id].add(f.i)
      return id
    }),
  )

  return { files, F, m, n, slots, rowOverlap, colFiles, colBase }
}

/**
 * Conflicting row and column keys. A row conflicts across the files that
 * contain it and share a column key with another such file; columns likewise.
 */
export function referenceConflicts(paths, options) {
  const { files, F, m, slots, rowOverlap, colFiles, colBase } = model(paths, options)
  const colOverlap = (a, b) => colFiles.some((s) => s.has(a) && s.has(b))
  const participants = (present, overlap) =>
    present.filter((a) => present.some((b) => b !== a && overlap(Math.min(a, b), Math.max(a, b))))
  const rows = []
  for (const s of slots) {
    const present = [...Array(F).keys()].filter((fi) => s[fi] !== -1)
    const src = participants(present, colOverlap)
    if (src.length === 0) continue
    const rec = files[present[0]].rows[s[present[0]]]
    const key = Array.from({ length: m }, (_, k) => (rec[k] === undefined ? '' : unquote(rec[k])))
    rows.push({ key, sources: src.map((fi) => files[fi].label) })
  }
  const first = new Map()
  colBase.forEach((ids, fi) => ids.forEach((id, j) => first.has(id) || first.set(id, [fi, j])))
  const cols = []
  colFiles.forEach((set, id) => {
    const src = participants([...set].sort((a, b) => a - b), rowOverlap)
    if (src.length === 0) return
    const [fi, j] = first.get(id)
    cols.push({ key: files[fi].headers.map((h) => unquote(h[m + j])), sources: src.map((x) => files[x].label) })
  })
  return { rows, cols }
}

export function referenceMerge(paths, options, policy) {
  const { files, F, m, n, slots, rowOverlap, colFiles, colBase } = model(paths, options)
  const outCols = []
  const baseOut = new Map()
  const sources = []
  files.forEach((f, fi) => {
    colBase[fi].forEach((bid, j) => {
      const conflicts =
        policy === 'keepAll' &&
        baseOut.has(bid) &&
        [...Array(fi).keys()].some((g) => colFiles[bid].has(g) && rowOverlap(g, fi))
      let target
      if (!baseOut.has(bid) || conflicts) {
        outCols.push({ fi, j, suffixed: conflicts })
        sources.push([])
        target = outCols.length - 1
        if (!baseOut.has(bid)) baseOut.set(bid, target)
      } else target = baseOut.get(bid)
      sources[target].push([fi, m + j])
    })
  })

  const lines = []
  for (let level = 0; level < n; level++) {
    const cells = files[0].headers[level].slice(0, m)
    for (const oc of outCols) {
      const f = files[oc.fi]
      const raw = f.headers[level][m + oc.j]
      cells.push(oc.suffixed && level === n - 1 ? escape(`${unquote(raw)}@${f.label}`) : raw)
    }
    lines.push(cells.join(','))
  }
  for (const s of slots) {
    const recs = s.map((ri, fi) => (ri === -1 ? null : files[fi].rows[ri]))
    const keyRec = recs.find((r) => r)
    const cells = keyRec.slice(0, m)
    while (cells.length < m) cells.push('')
    for (const src of sources) {
      let v = ''
      for (const [fi, col] of [...src].reverse()) {
        const raw = recs[fi]?.[col]
        if (raw !== undefined && !isEmpty(raw)) {
          v = raw
          break
        }
      }
      cells.push(v)
    }
    lines.push(cells.join(','))
  }
  return lines.join('\n') + '\n'
}
