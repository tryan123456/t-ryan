// Runs every case × backend × policy under /usr/bin/time and prints a table.
// Usage: node bench/bench.mjs [case...]   (results also saved to out/results.json)
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { cases } from './cases.mjs'

const here = dirname(fileURLToPath(import.meta.url))
mkdirSync(join(here, '..', 'out'), { recursive: true })
// BACKENDS=native,ts node bench/bench.mjs  → limit which implementations run
const backends = (process.env.BACKENDS ?? 'native,wasm,ts').split(',')
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(cases)

const results = []
for (const name of wanted) {
  const policies = name.includes('overlap') ? ['abort', 'overwrite', 'keepAll'] : ['abort', 'overwrite']
  for (const policy of policies) {
    for (const backend of backends) {
      const p = spawnSync('/usr/bin/time', ['-l', process.execPath, '--no-warnings', join(here, 'run-one.mjs'), backend, name, policy], {
        encoding: 'utf8',
        maxBuffer: 64 << 20,
      })
      const line = p.stdout.split('\n').find((l) => l.startsWith('RESULT '))
      if (!line) {
        console.error(`FAILED ${name} ${backend} ${policy}\n${p.stdout}\n${p.stderr}`)
        continue
      }
      const r = JSON.parse(line.slice(7))
      r.wallSec = Number(p.stderr.match(/([\d.]+) real/)[1])
      r.maxRss = Number(p.stderr.match(/(\d+)\s+maximum resident set size/)[1])
      r.peakFootprint = Number(p.stderr.match(/(\d+)\s+peak memory footprint/)[1])
      results.push(r)
      const mb = (x) => (x / 2 ** 20).toFixed(0).padStart(6)
      const s = (ms) => (ms === undefined ? '     -' : (ms / 1000).toFixed(2).padStart(6))
      console.log(
        `${name.padEnd(15)} ${policy.padEnd(9)} ${backend.padEnd(6)} open ${s(r.openMs)}s  merge ${s(r.mergeMs)}s  wall ${r.wallSec.toFixed(2).padStart(6)}s  ` +
          `peakRSS ${mb(r.maxRss)}MB  footprint ${mb(r.peakFootprint)}MB  wasmMem ${mb(r.wasmMemory)}MB  ` +
          `out ${r.outRows ?? ''}×${r.outCols ?? ''} ${r.outBytes ? (r.outBytes / 2 ** 30).toFixed(2) + 'GB' : ''}`,
      )
    }
  }
}
writeFileSync(join(here, '..', 'out', 'results.json'), JSON.stringify(results, null, 2))
