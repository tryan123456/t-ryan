// MurmurHash3 x86_128: a 128-bit non-cryptographic hash built from 32-bit
// operations, which JS can do natively (Math.imul). Plays the role xxh3-128
// plays in the Rust version; the hash never reaches the output.

const C1 = 0x239b961b
const C2 = 0xab0e9789
const C3 = 0x38b34ae5
const C4 = 0xa1e38b93

const rotl = (x: number, r: number) => (x << r) | (x >>> (32 - r))

function fmix(h: number): number {
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  return h ^ (h >>> 16)
}

const u32 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)

/** Hashes `data[0, len)` into `out[at .. at + 4)`. */
export function murmur128(data: Uint8Array, len: number, out: Uint32Array, at: number): void {
  let h1 = 0
  let h2 = 0
  let h3 = 0
  let h4 = 0
  const blocks = len & ~15
  for (let i = 0; i < blocks; i += 16) {
    let k1 = u32(data, i)
    let k2 = u32(data, i + 4)
    let k3 = u32(data, i + 8)
    let k4 = u32(data, i + 12)
    k1 = Math.imul(rotl(Math.imul(k1, C1), 15), C2)
    h1 ^= k1
    h1 = (Math.imul(rotl(h1, 19) + h2, 5) + 0x561ccd1b) | 0
    k2 = Math.imul(rotl(Math.imul(k2, C2), 16), C3)
    h2 ^= k2
    h2 = (Math.imul(rotl(h2, 17) + h3, 5) + 0x0bcaa747) | 0
    k3 = Math.imul(rotl(Math.imul(k3, C3), 17), C4)
    h3 ^= k3
    h3 = (Math.imul(rotl(h3, 15) + h4, 5) + 0x96cd1c35) | 0
    k4 = Math.imul(rotl(Math.imul(k4, C4), 18), C1)
    h4 ^= k4
    h4 = (Math.imul(rotl(h4, 13) + h1, 5) + 0x32ac3b17) | 0
  }

  const t = blocks
  let k1 = 0
  let k2 = 0
  let k3 = 0
  let k4 = 0
  switch (len & 15) {
    case 15: k4 ^= data[t + 14] << 16 // falls through
    case 14: k4 ^= data[t + 13] << 8 // falls through
    case 13:
      k4 ^= data[t + 12]
      h4 ^= Math.imul(rotl(Math.imul(k4, C4), 18), C1)
    // falls through
    case 12: k3 ^= data[t + 11] << 24 // falls through
    case 11: k3 ^= data[t + 10] << 16 // falls through
    case 10: k3 ^= data[t + 9] << 8 // falls through
    case 9:
      k3 ^= data[t + 8]
      h3 ^= Math.imul(rotl(Math.imul(k3, C3), 17), C4)
    // falls through
    case 8: k2 ^= data[t + 7] << 24 // falls through
    case 7: k2 ^= data[t + 6] << 16 // falls through
    case 6: k2 ^= data[t + 5] << 8 // falls through
    case 5:
      k2 ^= data[t + 4]
      h2 ^= Math.imul(rotl(Math.imul(k2, C2), 16), C3)
    // falls through
    case 4: k1 ^= data[t + 3] << 24 // falls through
    case 3: k1 ^= data[t + 2] << 16 // falls through
    case 2: k1 ^= data[t + 1] << 8 // falls through
    case 1:
      k1 ^= data[t]
      h1 ^= Math.imul(rotl(Math.imul(k1, C1), 15), C2)
  }

  h1 ^= len
  h2 ^= len
  h3 ^= len
  h4 ^= len
  h1 = (h1 + h2 + h3 + h4) | 0
  h2 = (h2 + h1) | 0
  h3 = (h3 + h1) | 0
  h4 = (h4 + h1) | 0
  h1 = fmix(h1)
  h2 = fmix(h2)
  h3 = fmix(h3)
  h4 = fmix(h4)
  h1 = (h1 + h2 + h3 + h4) | 0
  h2 = (h2 + h1) | 0
  h3 = (h3 + h1) | 0
  h4 = (h4 + h1) | 0
  out[at] = h1
  out[at + 1] = h2
  out[at + 2] = h3
  out[at + 3] = h4
}
