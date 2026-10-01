// Generates benchmark inputs into data/<case>/. Usage: node bench/gen.mjs [case...]
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { cases } from './cases.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'data')
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(cases)

const jobs = []
for (const name of wanted) {
  mkdirSync(join(root, name), { recursive: true })
  for (const f of cases[name]) {
    const path = join(root, name, f.name)
    if (!existsSync(path)) jobs.push({ path, ...f })
  }
}

const run = (spec) =>
  new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'gen-file.mjs'), JSON.stringify(spec)], {
      stdio: 'inherit',
    })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${spec.path} exited ${code}`))))
  })

const t0 = Date.now()
let next = 0
await Promise.all(
  Array.from({ length: Math.min(availableParallelism() - 2, jobs.length) }, async () => {
    while (next < jobs.length) {
      const spec = jobs[next++]
      await run(spec)
      console.log(`wrote ${spec.path}`)
    }
  }),
)
console.log(`${jobs.length} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
