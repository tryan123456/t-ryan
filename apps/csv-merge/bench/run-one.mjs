// One benchmark run in a fresh process, so peak memory is per-run.
// argv: <native|wasm> <case> <overwrite|keepAll|abort>
import { readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { availableParallelism } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [backend, caseName, policy] = process.argv.slice(2)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
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
const summary = job.conflicts()
const result = {
  backend,
  case: caseName,
  policy,
  files: files.length,
  inputBytes: summary.files.reduce((s, f) => s + f.bytes, 0),
  openMs: job.openMs,
  conflictCells: summary.totalCells,
  outRows: summary.outRows,
}
if (policy !== 'abort') {
  const out = join(root, 'out', `${caseName}-${backend}-${policy}.csv`)
  const stats = await job.merge(out, policy)
  Object.assign(result, { mergeMs: stats.elapsedMs, outCols: stats.cols, outBytes: stats.bytesWritten })
  rmSync(out)
}
result.wasmMemory = b.wasmMemoryBytes()
console.log('RESULT ' + JSON.stringify(result))
process.exit(0)
