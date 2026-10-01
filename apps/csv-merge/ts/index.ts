// TypeScript port of the Rust/napi csv-merge module, with the same API and
// byte-identical output. All work happens in worker threads, so calling
// this from Electron's main process does not block it.

import { availableParallelism } from 'node:os'
import { Worker } from 'node:worker_threads'

import type { JobInit, JobRequest, JobResponse } from './protocol.ts'
import type { ConflictKey, ConflictSummary, MergePolicy, MergeStats, OpenOptions } from './types.ts'

export type * from './types.ts'

export const __napiBindingTarget = 'typescript'

// Rust frees a job when its JS object is collected; terminating the worker
// here gives the same lifetime.
const reaper = new FinalizationRegistry<Worker>((w) => void w.terminate())

export class MergeJob {
  #worker: Worker
  #openMs: number
  #summary: ConflictSummary
  #nextId = 0
  #inFlight = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  /** @internal */
  constructor(worker: Worker, openMs: number, summary: ConflictSummary) {
    this.#worker = worker
    this.#openMs = openMs
    this.#summary = summary
    // The listener must not capture `this`: the running worker is rooted,
    // so that would keep the job alive forever.
    const inFlight = this.#inFlight
    worker.on('message', (msg: JobResponse) => {
      if (msg.type !== 'result' && msg.type !== 'failure') return
      const p = inFlight.get(msg.id)!
      inFlight.delete(msg.id)
      if (inFlight.size === 0) worker.unref()
      if (msg.type === 'result') p.resolve(msg.value)
      else p.reject(new Error(msg.message))
    })
    // An idle job must not keep the process alive.
    worker.unref()
    reaper.register(this, worker)
  }

  /** Duration of pass 1 (indexing), in milliseconds. */
  get openMs(): number {
    return this.#openMs
  }

  conflicts(): ConflictSummary {
    return structuredClone(this.#summary)
  }

  /**
   * Pass 2. Writes to `<outPath>.partial` and renames on success. To abort,
   * simply never call this.
   */
  merge(outPath: string, policy: MergePolicy): Promise<MergeStats> {
    if (policy !== 'overwrite' && policy !== 'keepAll') {
      return Promise.reject(new TypeError(`policy must be 'overwrite' or 'keepAll'`))
    }
    return this.#request({ type: 'merge', id: 0, outPath, policy })
  }

  /**
   * Conflicting row keys `[offset, offset + limit)`, in output order. Reads
   * each row's key back from its file, so cost is proportional to `limit`.
   */
  conflictRows(offset: number, limit: number): Promise<ConflictKey[]> {
    return this.#request({ type: 'conflictKeys', id: 0, rows: true, offset: toU32(offset), limit: toU32(limit) })
  }

  /** Conflicting column keys `[offset, offset + limit)`, in output order. */
  conflictCols(offset: number, limit: number): Promise<ConflictKey[]> {
    return this.#request({ type: 'conflictKeys', id: 0, rows: false, offset: toU32(offset), limit: toU32(limit) })
  }

  #request<T>(req: JobRequest): Promise<T> {
    return new Promise((resolve, reject) => {
      req.id = this.#nextId++
      this.#inFlight.set(req.id, { resolve: resolve as (v: unknown) => void, reject })
      this.#worker.ref()
      this.#worker.postMessage(req)
    })
  }
}

/** Same coercion napi applies to a `u32` argument (ECMAScript ToUint32). */
const toU32 = (x: number) => x >>> 0

/** Pass 1: index every file and compute key overlaps. */
export function openMergeJob(files: string[], options: OpenOptions): Promise<MergeJob> {
  const init: JobInit = {
    files: [...files],
    rowKeyCols: options.rowKeyCols,
    colKeyRows: options.colKeyRows,
    threads: options.threads ?? Math.min(availableParallelism(), 8),
    aliases: options.aliases ? [...options.aliases] : undefined,
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./job-worker.ts', import.meta.url), { workerData: init })
    const onError = (e: Error) => reject(e)
    worker.once('error', onError)
    worker.once('message', (msg: JobResponse) => {
      worker.off('error', onError)
      if (msg.type === 'opened') {
        resolve(new MergeJob(worker, msg.openMs, msg.summary))
      } else {
        void worker.terminate()
        reject(new Error(msg.type === 'openError' ? msg.message : `unexpected ${msg.type}`))
      }
    })
  })
}

/** Always 0: there is no WebAssembly memory in the TypeScript port. */
export function wasmMemoryBytes(): number {
  return 0
}
