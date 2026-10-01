// Compares the native and WASM builds against the JS reference on many small
// randomized inputs. Usage: node test/correctness.mjs [cases=300]
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { referenceConflicts, referenceMerge } from './reference.mjs'

const require = createRequire(import.meta.url)
const backends = {
  native: require('../csv-merge.darwin-arm64.node'),
  wasm: require('../csv-merge.wasi.cjs'),
  ts: await import('../ts/index.ts'),
}

let seed = 12345
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32)
const pick = (n) => Math.floor(rand() * n)
const chance = (p) => rand() < p

function value() {
  const r = rand()
  if (r < 0.15) return ''
  if (r < 0.2) return '""'
  if (r < 0.25) return '"a,b"'
  if (r < 0.28) return '"line\nbreak"'
  if (r < 0.31) return '"say ""hi"""'
  return String(pick(1000))
}

// Composite keys: individual levels repeat, only the tuple is unique.
const part = (count, i, level) => (count === 1 ? i : [i % 3, Math.floor(i / 3), i % 2][level])

function keyPart(prefix, i) {
  return chance(0.1) ? `"${prefix}${i}"` : `${prefix}${i}` // same logical key, quoted or not
}

function makeCase(dir) {
  const f = 2 + pick(5)
  const m = 1 + pick(3)
  const n = 1 + pick(3)
  const paths = []
  for (let fi = 0; fi < f; fi++) {
    const cols = [...new Set(Array.from({ length: 1 + pick(6) }, () => pick(10)))]
    if (chance(0.1)) cols.push(cols[0]) // duplicate column key within a file
    const rows = Array.from({ length: pick(8) }, () => pick(15))
    const eol = chance(0.3) ? '\r\n' : '\n'
    const lines = []
    for (let level = 0; level < n; level++) {
      const corner = Array.from({ length: m }, (_, k) => `k${k}`)
      lines.push([...corner, ...cols.map((c) => keyPart(`L${level}c`, part(n, c, level)))].join(','))
    }
    for (const r of rows) {
      const key = Array.from({ length: m }, (_, k) => keyPart(`r${k}_`, part(m, r, k)))
      lines.push([...key, ...cols.map(value)].join(','))
    }
    const sub = chance(0.15) ? join(dir, `d${fi}`) : dir
    mkdirSync(sub, { recursive: true })
    const name = chance(0.15) && fi > 0 ? 'same.csv' : `f${fi}.csv`
    const p = join(sub, name)
    if (paths.includes(p)) {
      paths.push(join(sub, `g${fi}.csv`))
    } else paths.push(p)
    writeFileSync(paths.at(-1), (chance(0.1) ? '﻿' : '') + lines.join(eol) + (chance(0.8) ? eol : ''))
  }
  const options = { rowKeyCols: m, colKeyRows: n }
  // Aliases include characters that need escaping in the suffixed header.
  const names = ['2024Q1', '來源B', 'a,b', 'say "x"', 'v2', 'Ω', 'z']
  if (chance(0.5)) options.aliases = names.slice(0, f)
  return { paths, options }
}

const total = Number(process.argv[2] ?? 300)
const root = join(tmpdir(), `csv-merge-test-${process.pid}`)
let failures = 0
let withConflicts = 0
let withAliases = 0
for (let c = 0; c < total; c++) {
  const dir = join(root, String(c))
  mkdirSync(dir, { recursive: true })
  const { paths, options } = makeCase(dir)
  const expectedObj = referenceConflicts(paths, options)
  const expectedConflicts = JSON.stringify(expectedObj)
  if (expectedObj.rows.length) withConflicts++
  if (options.aliases) withAliases++
  for (const [name, b] of Object.entries(backends)) {
    const job = await b.openMergeJob(paths, options)
    const got = { rows: await job.conflictRows(0, 2 ** 31), cols: await job.conflictCols(0, 2 ** 31) }
    const summary = job.conflicts()
    const paged = [...(await job.conflictRows(0, 2)), ...(await job.conflictRows(2, 2 ** 31))]
    if (
      JSON.stringify(got) !== expectedConflicts ||
      summary.conflictRows !== got.rows.length ||
      summary.conflictCols !== got.cols.length ||
      JSON.stringify(paged) !== JSON.stringify(got.rows)
    ) {
      failures++
      if (failures <= 3) console.error(`CONFLICT KEYS MISMATCH case=${c} backend=${name} dir=${dir}\nexpected ${expectedConflicts}\ngot      ${JSON.stringify(got)}`)
    }
  }
  for (const policy of ['overwrite', 'keepAll']) {
    const expected = referenceMerge(paths, options, policy)
    for (const [name, b] of Object.entries(backends)) {
      const out = join(dir, `out-${name}-${policy}.csv`)
      const job = await b.openMergeJob(paths, options)
      await job.merge(out, policy)
      const got = readFileSync(out, 'utf8')
      if (got !== expected) {
        failures++
        if (failures <= 3) {
          console.error(`MISMATCH case=${c} backend=${name} policy=${policy} dir=${dir}`)
          console.error('--- expected\n' + expected + '--- got\n' + got)
        }
      }
    }
  }
}

// Conflict summary must not depend on the backend.
const { paths, options } = makeCase(join(root, 'summary'))
const summaries = await Promise.all(Object.values(backends).map(async (be) => (await be.openMergeJob(paths, options)).conflicts()))
const strip = (s) => JSON.stringify({ ...s, files: s.files.map(({ path, ...rest }) => rest) })
if (new Set(summaries.map(strip)).size !== 1) {
  failures++
  console.error('conflict summaries differ', summaries)
}

if (failures === 0) rmSync(root, { recursive: true, force: true })
console.log(
  failures === 0
    ? `ok: ${total} cases × 2 policies × 3 backends match the reference (${withConflicts} with conflicts, ${withAliases} with aliases)`
    : `${failures} failures`,
)
process.exit(failures === 0 ? 0 : 1)
