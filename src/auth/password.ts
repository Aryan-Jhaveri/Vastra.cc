import { scryptSync, randomBytes, timingSafeEqual } from 'crypto'

const SALT_BYTES = 16
const HASH_BYTES = 64

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES).toString('hex')
  const hash = scryptSync(password, salt, HASH_BYTES).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hashHex] = stored.split(':')
  if (!salt || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = scryptSync(password, salt, HASH_BYTES)
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}
