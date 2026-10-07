const compact = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })

/** Axis ticks and tight columns. */
export const formatCompact = (value: number) => compact.format(value)

/** Tooltips, table cells — readable precision. */
export const formatValue = (value: number, unit = '') =>
  `${decimal.format(value)}${unit}`

export const formatDate = (ms: number) =>
  new Date(ms).toISOString().slice(0, 10)

export const formatCount = (n: number) => new Intl.NumberFormat('en-US').format(n)
