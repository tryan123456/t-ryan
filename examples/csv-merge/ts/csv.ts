// RFC 4180 CSV scanning primitives; mirrors src/scan.rs.
//
// Everything works on bytes so offsets are byte offsets. Fields stay in their
// raw (still-quoted) form so they can be copied to the output verbatim.

import { readSync } from 'node:fs'

import { murmur128 } from './hash.ts'

export const QUOTE = 0x22
export const COMMA = 0x2c
export const LF = 0x0a
export const CR = 0x0d

export function trimEol(buf: Uint8Array, start: number, end: number): number {
  while (end > start && (buf[end - 1] === LF || buf[end - 1] === CR)) end--
  return end
}

/**
 * Streams records out of a file descriptor, tracking each record's file offset.
 * After `next()` returns true the record is `buf[recStart, recEnd)` (line
 * ending trimmed) at file offset `recOffset`.
 */
export class RecordReader {
  buf: Buffer
  recOffset = 0
  recStart = 0
  recEnd = 0
  private fd: number
  private start = 0
  private end = 0
  private base = 0
  private eof = false
  /**
   * Cached positions of the next quote / newline at or after the last lookup
   * (`end` when there is none). Rust's memchr2 finds either byte in one pass;
   * two separate `indexOf` scans would otherwise re-scan the rest of a long
   * record after every quote.
   */
  private quote = -1
  private newline = -1

  constructor(fd: number, capacity: number) {
    this.fd = fd
    this.buf = Buffer.allocUnsafeSlow(capacity)
  }

  next(): boolean {
    for (;;) {
      const len = this.findRecordEnd()
      if (len >= 0) {
        this.setRecord(this.start, this.start + len)
        this.start += len
        return true
      }
      if (this.eof) {
        if (this.start === this.end) return false
        this.setRecord(this.start, this.end)
        this.start = this.end
        return true
      }
      this.refill()
    }
  }

  private setRecord(s: number, e: number) {
    this.recOffset = this.base + s
    this.recStart = s
    this.recEnd = trimEol(this.buf, s, e)
  }

  private nextQuote(i: number): number {
    if (this.quote < i) {
      const q = this.buf.indexOf(QUOTE, i)
      this.quote = q === -1 || q >= this.end ? this.end : q
    }
    return this.quote < this.end ? this.quote : -1
  }

  private nextNewline(i: number): number {
    if (this.newline < i) {
      const q = this.buf.indexOf(LF, i)
      this.newline = q === -1 || q >= this.end ? this.end : q
    }
    return this.newline < this.end ? this.newline : -1
  }

  /**
   * Length of the record at `start` including its `\n`, or -1 when it is not
   * terminated within the buffer. A `""` escape toggles the quote state
   * twice, so parity tracking is enough.
   */
  private findRecordEnd(): number {
    let i = this.start
    for (;;) {
      const nl = this.nextNewline(i)
      const q = this.nextQuote(i)
      if (q === -1 || (nl !== -1 && nl < q)) return nl === -1 ? -1 : nl + 1 - this.start
      const close = this.nextQuote(q + 1)
      if (close === -1) return -1
      i = close + 1
    }
  }

  private refill() {
    if (this.start > 0) {
      this.buf.copy(this.buf, 0, this.start, this.end)
      this.base += this.start
      this.end -= this.start
      this.start = 0
    }
    if (this.end === this.buf.length) {
      // A single record is larger than the buffer.
      const grown = Buffer.allocUnsafeSlow(this.buf.length * 2)
      this.buf.copy(grown, 0, 0, this.end)
      this.buf = grown
    }
    const n = readSync(this.fd, this.buf, this.end, this.buf.length - this.end, this.base + this.end)
    if (n === 0) this.eof = true
    this.end += n
    this.quote = -1
    this.newline = -1
  }
}

/** Raw field ranges as `[start0, end0, start1, end1, ...]`, absolute in the record's buffer. */
export class Fields {
  r = new Int32Array(64)
  n = 0

  start(i: number): number {
    return this.r[2 * i]
  }

  end(i: number): number {
    return this.r[2 * i + 1]
  }

  push(s: number, e: number) {
    if (2 * this.n + 2 > this.r.length) {
      const grown = new Int32Array(this.r.length * 2)
      grown.set(this.r)
      this.r = grown
    }
    this.r[2 * this.n] = s
    this.r[2 * this.n + 1] = e
    this.n++
  }
}

/** Splits up to `max` raw fields of `buf[s, e)` into `out`. */
export function splitFields(buf: Uint8Array, s: number, e: number, max: number, out: Fields) {
  out.n = 0
  let start = s
  let inQuote = false
  for (let i = s; i < e; i++) {
    const c = buf[i]
    if (c === QUOTE) inQuote = !inQuote
    else if (c === COMMA && !inQuote) {
      out.push(start, i)
      start = i + 1
      if (out.n === max) return
    }
  }
  out.push(start, e)
}

export function isEmpty(buf: Uint8Array, s: number, e: number): boolean {
  return s === e || (e - s === 2 && buf[s] === QUOTE && buf[s + 1] === QUOTE)
}

/** The logical value of a raw field (quotes removed, `""` collapsed). */
export function unquote(buf: Uint8Array, s: number, e: number): Uint8Array {
  if (e - s < 2 || buf[s] !== QUOTE || buf[e - 1] !== QUOTE) return buf.subarray(s, e)
  const out = new Uint8Array(e - s - 2)
  let n = 0
  for (let i = s + 1; i < e - 1; i++) {
    out[n++] = buf[i]
    if (buf[i] === QUOTE) i++
  }
  return out.subarray(0, n)
}

export function escaped(value: Uint8Array): Uint8Array {
  if (!value.some((c) => c === COMMA || c === QUOTE || c === LF || c === CR)) return value
  const out: number[] = [QUOTE]
  for (const c of value) {
    if (c === QUOTE) out.push(QUOTE)
    out.push(c)
  }
  out.push(QUOTE)
  return Uint8Array.from(out)
}

/**
 * Order-sensitive hash of a composite key. Each part is written as
 * `u32 length (LE) + unquoted bytes`, so `("ab","c")` and `("a","bc")` differ.
 */
export class KeyHasher {
  private scratch = new Uint8Array(256)
  private len = 0

  reset() {
    this.len = 0
  }

  part(buf: Uint8Array, s: number, e: number) {
    if (this.len + 4 + (e - s) > this.scratch.length) {
      const grown = new Uint8Array(Math.max(this.scratch.length * 2, this.len + 4 + (e - s)))
      grown.set(this.scratch.subarray(0, this.len))
      this.scratch = grown
    }
    const sc = this.scratch
    const at = this.len
    let n = at + 4
    if (e - s >= 2 && buf[s] === QUOTE && buf[e - 1] === QUOTE) {
      for (let i = s + 1; i < e - 1; i++) {
        sc[n++] = buf[i]
        if (buf[i] === QUOTE) i++
      }
    } else {
      for (let i = s; i < e; i++) sc[n++] = buf[i]
    }
    const partLen = n - at - 4
    sc[at] = partLen & 0xff
    sc[at + 1] = (partLen >>> 8) & 0xff
    sc[at + 2] = (partLen >>> 16) & 0xff
    sc[at + 3] = partLen >>> 24
    this.len = n
  }

  finish(out: Uint32Array, at: number) {
    murmur128(this.scratch, this.len, out, at)
  }
}

/** Appends bytes into a growable buffer. Callers reserve space up front with `ensure`. */
export class ByteBuilder {
  buf: Buffer
  len = 0

  constructor(capacity: number) {
    this.buf = Buffer.allocUnsafeSlow(capacity)
  }

  ensure(extra: number) {
    if (this.len + extra <= this.buf.length) return
    const grown = Buffer.allocUnsafeSlow(Math.max(this.buf.length * 2, this.len + extra))
    this.buf.copy(grown, 0, 0, this.len)
    this.buf = grown
  }

  byte(c: number) {
    this.buf[this.len++] = c
  }

  bytes(src: Uint8Array, s: number, e: number) {
    const n = e - s
    if (n < 16) {
      const b = this.buf
      let at = this.len
      for (let i = s; i < e; i++) b[at++] = src[i]
    } else {
      this.buf.set(src.subarray(s, e), this.len)
    }
    this.len += n
  }
}

/** A read window per source file, so rows that are sequential within a file stay sequential reads. */
export class WindowReader {
  buf: Buffer
  private fd: number
  private pos = 0
  private len = 0

  constructor(fd: number, capacity: number) {
    this.fd = fd
    this.buf = Buffer.allocUnsafeSlow(capacity)
  }

  /** Makes `[off, off + span)` available in `buf`; returns its start index. */
  read(off: number, span: number): number {
    if (off >= this.pos && off + span <= this.pos + this.len) return off - this.pos
    if (span > this.buf.length) this.buf = Buffer.allocUnsafeSlow(span)
    this.pos = off
    this.len = readSync(this.fd, this.buf, 0, this.buf.length, off)
    if (this.len < span) throw new Error('unexpected end of file')
    return 0
  }
}
