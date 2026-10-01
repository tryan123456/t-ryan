// Small helpers shared by the job and render workers.

/** File that owns global row `g`, given each file's first global row plus the total. */
export function fileOf(fileBase: Uint32Array, g: number): number {
  let lo = 0
  let hi = fileBase.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1
    if (fileBase[mid] <= g) lo = mid
    else hi = mid
  }
  return lo
}

/** Calls `visit(a, b)` for every pair `a < b` of files set in the mask (two 32-bit halves). */
export function pairs(lo: number, hi: number, f: number, visit: (a: number, b: number) => void) {
  const has = (i: number) => (i < 32 ? (lo >>> i) & 1 : (hi >>> (i - 32)) & 1) === 1
  for (let a = 0; a < f; a++) {
    if (!has(a)) continue
    for (let b = a + 1; b < f; b++) if (has(b)) visit(a, b)
  }
}
