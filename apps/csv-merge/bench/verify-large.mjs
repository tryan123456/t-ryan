// Checks that large outputs are byte-identical across thread counts and
// backends (small randomized cases fit in one batch and cannot catch
// batch-ordering bugs). Usage: node bench/verify-large.mjs [case...]
import { createHash } from 'node:crypto'
import { createReadStream, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const native = require(join(root, 'csv-merge.darwin-arm64.node'))
const wasm = require(join(root, 'csv-merge.wasi.cjs'))
const ts = await import('../ts/index.ts')

const sha = (p) =>
  new Promise((resolve) => {
    const h = createHash('sha256')
    createReadStream(p, { highWaterMark: 8 << 20 })
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex').slice(0, 16)))
  })

let ok = true
for (const name of process.argv.slice(2)) {
  const dir = join(root, 'data', name)
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.csv'))
    .sort((a, b) => Number(a.slice(1, -4)) - Number(b.slice(1, -4)))
    .map((f) => join(dir, f))
  for (const policy of name.includes('overlap') ? ['overwrite', 'keepAll'] : ['overwrite']) {
    const runs = [
      ['native t=1', native, 1],
      ['native t=8', native, 8],
      ['wasm   t=8', wasm, 8],
      ['ts     t=1', ts, 1],
      ['ts     t=8', ts, 8],
    ]
    const hashes = []
    for (const [label, b, threads] of runs) {
      const out = join(root, 'out', `verify-${name}-${policy}.csv`)
      const job = await b.openMergeJob(files, { rowKeyCols: 2, colKeyRows: 2, threads })
      await job.merge(out, policy)
      hashes.push(`${label}: ${await sha(out)}`)
      rmSync(out)
    }
    const same = new Set(hashes.map((h) => h.split(': ')[1])).size === 1
    ok &&= same
    console.log(`${same ? 'same' : 'DIFF'}  ${name} ${policy}  ${hashes.join('  ')}`)
  }
}
process.exit(ok ? 0 : 1)
