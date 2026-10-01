// Cost of listing conflicting keys. Each run is a fresh process under
// /usr/bin/time so peak memory is per run.
// Usage: node bench/conflict-keys.mjs [case...]
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { availableParallelism } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

if (process.argv[2] === '--child') {
  const [, , , backend, caseName, mode] = process.argv
  const require = createRequire(import.meta.url)
  const b =
    backend === 'ts'
      ? await import('../ts/index.ts')
      : require(join(root, backend === 'wasm' ? 'csv-merge.wasi.cjs' : 'csv-merge.darwin-arm64.node'))
  const dir = join(root, 'data', caseName)
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.csv'))
    .sort((x, y) => Number(x.slice(1, -4)) - Number(y.slice(1, -4)))
    .map((f) => join(dir, f))
  const threads = Math.min(availableParallelism(), 8)
  const job = await b.openMergeJob(files, { rowKeyCols: 2, colKeyRows: 2, threads })
  const s = job.conflicts()
  const r = { openMs: job.openMs, conflictRows: s.conflictRows, conflictCols: s.conflictCols }
  let t = performance.now()
  if (mode === 'page') {
    await job.conflictRows(0, 1000)
    r.rowsMs = performance.now() - t
    t = performance.now()
    await job.conflictCols(0, 1000)
    r.colsMs = performance.now() - t
  } else if (mode === 'all') {
    // Page through everything, keeping nothing (like streaming to a report).
    for (let off = 0; off < s.conflictRows; off += 100_000) await job.conflictRows(off, 100_000)
    r.rowsMs = performance.now() - t
    t = performance.now()
    for (let off = 0; off < s.conflictCols; off += 100_000) await job.conflictCols(off, 100_000)
    r.colsMs = performance.now() - t
  }
  console.log('RESULT ' + JSON.stringify(r))
  process.exit(0)
}

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ['tall-overlap', 'tall-overlap-8', 'wide-overlap']
const ms = (x) => (x === undefined ? '     -' : x < 1000 ? `${x.toFixed(0)}ms`.padStart(6) : `${(x / 1000).toFixed(2)}s`.padStart(6))
for (const name of wanted) {
  for (const mode of ['none', 'page', 'all']) {
    for (const backend of ['native', 'wasm', 'ts']) {
      const p = spawnSync('/usr/bin/time', ['-l', process.execPath, '--no-warnings', fileURLToPath(import.meta.url), '--child', backend, name, mode], {
        encoding: 'utf8',
        maxBuffer: 64 << 20,
      })
      const line = p.stdout.split('\n').find((l) => l.startsWith('RESULT '))
      if (!line) {
        console.error(`FAILED ${name} ${backend} ${mode}\n${p.stderr.slice(-2000)}`)
        continue
      }
      const r = JSON.parse(line.slice(7))
      const rss = Number(p.stderr.match(/(\d+)\s+maximum resident set size/)[1]) / 2 ** 20
      console.log(
        `${name.padEnd(15)} ${mode.padEnd(5)} ${backend.padEnd(6)} open ${ms(r.openMs)}  rows ${ms(r.rowsMs)}  cols ${ms(r.colsMs)}  ` +
          `peakRSS ${rss.toFixed(0).padStart(5)}MB  conflictRows ${r.conflictRows}  conflictCols ${r.conflictCols}`,
      )
    }
  }
}
