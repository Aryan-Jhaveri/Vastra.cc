import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

function getEncryptionSecret(): string {
  return process.env.BACKUP_ENCRYPTION_SECRET ?? ''
}

function assertEncryptionSecret(): Buffer {
  const secret = getEncryptionSecret()
  if (!secret) {
    throw new Error('BACKUP_ENCRYPTION_SECRET is not set — cannot encrypt/decrypt backups')
  }
  const key = Buffer.from(secret, 'base64')
  if (key.length !== 32) {
    throw new Error(`BACKUP_ENCRYPTION_SECRET must decode to exactly 32 bytes, got ${key.length}`)
  }
  return key
}

export function encryptBuffer(plaintext: Buffer): Buffer {
  const key = assertEncryptionSecret()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, encrypted])
}

export function decryptBuffer(ciphertext: Buffer): Buffer {
  const key = assertEncryptionSecret()
  if (ciphertext.length < 28) {
    throw new Error('Ciphertext too short — expected at least 28 bytes (12 IV + 16 tag)')
  }
  const iv = ciphertext.subarray(0, 12)
  const authTag = ciphertext.subarray(12, 28)
  const encrypted = ciphertext.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()])
}
