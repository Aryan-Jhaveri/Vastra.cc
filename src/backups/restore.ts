import { createHash } from 'crypto'
import { copyFileSync, existsSync, unlinkSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DATA_DIR } from '../db/client.js'
import { decryptBuffer } from './encryption.js'
import { getStore } from './r2.js'

export interface RestoreOptions {
  dryRun?: boolean
}

export interface RestoreResult {
  verifiedChecksum: boolean
  restoredTo?: string
  preRestoreCopy?: string
  key: string
  sha256Plain: string
  sizeBytes: number
}

export async function restoreBackup(key: string, opts: RestoreOptions = {}): Promise<RestoreResult> {
  const store = getStore()

  const head = await store.head(key)
  if (!head) {
    throw new Error(`Backup not found: ${key}`)
  }

  const expectedSha256 = head.metadata?.['sha256-plain']
  if (!expectedSha256) {
    throw new Error(`Backup missing sha256-plain metadata: ${key}`)
  }

  const encryptedBuffer = await store.get(key)
  const decryptedBuffer = decryptBuffer(encryptedBuffer)

  const actualSha256 = createHash('sha256').update(decryptedBuffer).digest('hex')
  const verifiedChecksum = actualSha256 === expectedSha256

  if (!verifiedChecksum) {
    throw new Error(
      `SHA-256 mismatch for ${key}: expected ${expectedSha256}, got ${actualSha256}`
    )
  }

  if (opts.dryRun) {
    return {
      verifiedChecksum,
      key,
      sha256Plain: actualSha256,
      sizeBytes: decryptedBuffer.length,
    }
  }

  const dbPath = join(DATA_DIR, 'closet.db')
  const walPath = join(DATA_DIR, 'closet.db-wal')
  const shmPath = join(DATA_DIR, 'closet.db-shm')

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const preRestoreCopy = `${dbPath}.pre-restore-${ts}`

  if (existsSync(dbPath)) {
    copyFileSync(dbPath, preRestoreCopy)
  }

  const tmpDecryptedPath = join(DATA_DIR, `closet-restored-${ts}.db`)
  writeFileSync(tmpDecryptedPath, decryptedBuffer)

  if (existsSync(walPath)) {
    unlinkSync(walPath)
  }
  if (existsSync(shmPath)) {
    unlinkSync(shmPath)
  }

  renameSync(tmpDecryptedPath, dbPath)

  return {
    verifiedChecksum,
    restoredTo: dbPath,
    preRestoreCopy,
    key,
    sha256Plain: actualSha256,
    sizeBytes: decryptedBuffer.length,
  }
}
