// Benchmark cases. Every file is ~300 MB; both keys are 2-level composites.
const TALL = { rows: 2_000_000, cols: 20 }
const WIDE = { rows: 450, cols: 100_000 }
const SPARSE = { rows: 10_000, cols: 4_500 }

const files = (count, fn) => Array.from({ length: count }, (_, i) => ({ name: `f${i}.csv`, salt: i + 1, ...fn(i) }))

export const cases = {
  // 5 × 2M rows, same 20 columns, disjoint rows → vertical append, no conflicts.
  'tall-append': files(5, (i) => ({ rowStart: i * TALL.rows, rowCount: TALL.rows, colStart: 0, colCount: TALL.cols })),
  // Neighbouring files share 50% of their rows → 1M × 20 conflicting cells per pair.
  'tall-overlap': files(5, (i) => ({ rowStart: i * TALL.rows / 2, rowCount: TALL.rows, colStart: 0, colCount: TALL.cols })),
  'tall-overlap-8': files(8, (i) => ({ rowStart: i * TALL.rows / 2, rowCount: TALL.rows, colStart: 0, colCount: TALL.cols })),
  // 5 × 100k columns, same 450 rows, disjoint columns → 500k output columns.
  'wide-join': files(5, (i) => ({ rowStart: 0, rowCount: WIDE.rows, colStart: i * WIDE.cols, colCount: WIDE.cols })),
  // Neighbouring files share 50% of their columns.
  'wide-overlap': files(5, (i) => ({ rowStart: 0, rowCount: WIDE.rows, colStart: i * WIDE.cols / 2, colCount: WIDE.cols })),
  // Disjoint rows and columns → 50k × 22.5k mostly-empty output.
  'sparse-blowup': files(5, (i) => ({
    rowStart: i * SPARSE.rows,
    rowCount: SPARSE.rows,
    colStart: i * SPARSE.cols,
    colCount: SPARSE.cols,
  })),
}
