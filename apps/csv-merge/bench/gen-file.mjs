// Writes one synthetic 2-D CSV. Spec (JSON argv[2]):
//   { path, rowStart, rowCount, colStart, colCount, salt }
// Row key: (R<r%50>, id<r/50>). Column key: (Y<2000+c%25>, m<c/25>).
import { createWriteStream } from 'node:fs'
import { once } from 'node:events'

const { path, rowStart, rowCount, colStart, colCount, salt } = JSON.parse(process.argv[2])
const out = createWriteStream(path, { highWaterMark: 8 << 20 })

const hash = (r, c) => {
  let h = Math.imul(r ^ salt, 0x9e3779b1) ^ Math.imul(c + 0x7f4a7c15, 0x85ebca6b)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  return (h ^ (h >>> 12)) >>> 0
}
const cell = (r, c) => {
  const h = hash(r, c)
  const k = h % 1000
  if (k < 50) return ''
  if (k === 999) return '"x,y"'
  return String((h >>> 10) % 100000 / 100)
}

const cols = Array.from({ length: colCount }, (_, i) => colStart + i)
let chunk = ''
const flush = async (force) => {
  if (chunk.length < (4 << 20) && !force) return
  if (!out.write(chunk)) await once(out, 'drain')
  chunk = ''
}

chunk += 'region,id,' + cols.map((c) => `Y${2000 + (c % 25)}`).join(',') + '\n'
chunk += 'region,id,' + cols.map((c) => `m${Math.floor(c / 25)}`).join(',') + '\n'
const values = new Array(colCount)
for (let r = rowStart; r < rowStart + rowCount; r++) {
  for (let i = 0; i < colCount; i++) values[i] = cell(r, cols[i])
  chunk += `R${r % 50},id${Math.floor(r / 50)},${values.join(',')}\n`
  await flush(false)
}
await flush(true)
out.end()
await once(out, 'finish')
