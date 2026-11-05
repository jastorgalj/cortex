/** Generador de ULID (Universally Unique Lexicographically Sortable Identifier). */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function generateUlid(): string {
  const t = Date.now()
  let tStr = ''
  let tmp = t
  for (let i = 9; i >= 0; i--) {
    tStr = (ENCODING[tmp % 32] ?? '0') + tStr
    tmp = Math.floor(tmp / 32)
  }

  const random = crypto.getRandomValues(new Uint8Array(16))
  let rStr = ''
  for (const byte of random) {
    rStr += ENCODING[byte % 32] ?? '0'
  }

  return tStr + rStr
}
