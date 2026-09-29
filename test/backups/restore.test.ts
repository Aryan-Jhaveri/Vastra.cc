import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { randomBytes, createHash } from 'crypto'
import { rmSync, mkdirSync, existsSync, readdirSync, readFileSync, unlinkSync, openSync, writeSync, closeSync } from 'fs'
import { join, basename } from 'path'
import { tmpdir } from 'os'
import { db, DATA_DIR, getSqlite, resetDbForTesting } from '../../src/db/client.js'
import { users, items } from '../../src/db/schema.js'
import { encryptBuffer, decryptBuffer } from '../../src/backups/encryption.js'
import { setStoreForTesting, type BackupStoreInterface, type BackupObject, type PutResult, type HeadResult } from '../../src/backups/r2.js'
import { runBackup } from '../../src/backups/backup.js'
import { restoreBackup } from '../../src/backups/restore.js'

const ENCRYPTION_SECRET = randomBytes(32).toString('base64')

class MemoryBackupStore implements BackupStoreInterface {
  private store = new Map<string, { body: Buffer; metadata?: Record<string, string>; lastModified: Date }>()

  async put(key: string, body: Buffer, metadata?: Record<string, string>): Promise<PutResult> {
    this.store.set(key, { body, metadata, lastModified: new Date() })
    return { etag: `etag-${key}`, size: body.length }
  }

  async get(key: string): Promise<Buffer> {
    const obj = this.store.get(key)
    if (!obj) throw new Error(`Key not found: ${key}`)
    return obj.body
  }

  async head(key: string): Promise<HeadResult | null> {
    const obj = this.store.get(key)
    if (!obj) return null
    return {
      size: obj.body.length,
      lastModified: obj.lastModified,
      metadata: obj.metadata,
    }
  }

  async list(prefix: string, _maxKeys?: number): Promise<BackupObject[]> {
    const results: BackupObject[] = []
    for (const [key, obj] of this.store.entries()) {
      if (key.startsWith(prefix)) {
        results.push({
          key,
          size: obj.body.length,
          lastModified: obj.lastModified,
        })
      }
    }
    return results.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }

  clear(): void {
    this.store.clear()
  }

  getMetadata(key: string): Record<string, string> | undefined {
    return this.store.get(key)?.metadata
  }
}

let originalSecret: string | undefined
let memoryStore: MemoryBackupStore

beforeAll(() => {
  originalSecret = process.env.BACKUP_ENCRYPTION_SECRET
  process.env.BACKUP_ENCRYPTION_SECRET = ENCRYPTION_SECRET

  memoryStore = new MemoryBackupStore()
  setStoreForTesting(memoryStore)
})

afterAll(() => {
  setStoreForTesting(null)

  if (originalSecret !== undefined) {
    process.env.BACKUP_ENCRYPTION_SECRET = originalSecret
  } else {
    delete process.env.BACKUP_ENCRYPTION_SECRET
  }
})

beforeEach(() => {
  memoryStore.clear()
})

afterEach(() => {
  const sqlite = getSqlite()
  sqlite.exec("DELETE FROM items WHERE id LIKE 'test-%'")
  sqlite.exec("DELETE FROM users WHERE id LIKE 'test-%'")
})

describe('Encryption', () => {
  it('encrypts and decrypts a buffer correctly', () => {
    const plaintext = Buffer.from('test data for encryption')
    const encrypted = encryptBuffer(plaintext)
    const decrypted = decryptBuffer(encrypted)
    expect(decrypted.toString()).toBe('test data for encryption')
  })

  it('produces different ciphertext for same plaintext (random IV)', () => {
    const plaintext = Buffer.from('same data')
    const encrypted1 = encryptBuffer(plaintext)
    const encrypted2 = encryptBuffer(plaintext)
    expect(encrypted1.equals(encrypted2)).toBe(false)
    expect(decryptBuffer(encrypted1).toString()).toBe('same data')
    expect(decryptBuffer(encrypted2).toString()).toBe('same data')
  })

  it('fails on tampered ciphertext', () => {
    const plaintext = Buffer.from('original data')
    const encrypted = encryptBuffer(plaintext)
    encrypted[encrypted.length - 5] ^= 0xff
    expect(() => decryptBuffer(encrypted)).toThrow(/auth tag|Unsupported state|decrypt/i)
  })
})

describe('Backup and Restore', () => {
  it('creates a backup with correct key format and metadata', async () => {
    const ts = Date.now()
    const user = db.insert(users)
      .values({
        id: `test-backup-user-${ts}`,
        email: `backup-${ts}@example.com`,
        name: 'Backup Test',
        createdAt: ts,
      })
      .returning()
      .get()

    const result = await runBackup()
    expect(result.key).toMatch(/^db\/\d{4}-\d{2}-\d{2}\/closet-\d{6}\.db\.enc$/)
    expect(result.sizeBytes).toBeGreaterThan(0)
    expect(result.sha256Plain).toMatch(/^[a-f0-9]{64}$/)

    const head = await memoryStore.head(result.key)
    expect(head).not.toBeNull()
    expect(head!.metadata?.['sha256-plain']).toBe(result.sha256Plain)
  })

  it('dry-run restore verifies checksum without modifying files', async () => {
    const ts = Date.now()
    const user = db.insert(users)
      .values({
        id: `test-dryrun-user-${ts}`,
        email: `dryrun-${ts}@example.com`,
        name: 'Dry Run Test',
        createdAt: ts,
      })
      .returning()
      .get()

    const result = await runBackup()

    const filesBefore = readdirSync(DATA_DIR).filter(f => f.startsWith('closet.db.pre-restore'))

    const restoreResult = await restoreBackup(result.key, { dryRun: true })

    expect(restoreResult.verifiedChecksum).toBe(true)
    expect(restoreResult.restoredTo).toBeUndefined()
    expect(restoreResult.preRestoreCopy).toBeUndefined()
    expect(restoreResult.key).toBe(result.key)
    expect(restoreResult.sha256Plain).toBe(result.sha256Plain)

    const filesAfter = readdirSync(DATA_DIR).filter(f => f.startsWith('closet.db.pre-restore'))
    expect(filesAfter.length).toBe(filesBefore.length)
  })

  it('restore fails with clear error on tampered ciphertext', async () => {
    const ts = Date.now()
    const user = db.insert(users)
      .values({
        id: `test-tamper-user-${ts}`,
        email: `tamper-${ts}@example.com`,
        name: 'Tamper Test',
        createdAt: ts,
      })
      .returning()
      .get()

    const result = await runBackup()

    const encrypted = await memoryStore.get(result.key)
    const metadata = memoryStore.getMetadata(result.key)
    const tampered = Buffer.from(encrypted)
    tampered[tampered.length - 10] ^= 0xff
    await memoryStore.put(result.key, tampered, metadata)

    await expect(restoreBackup(result.key, { dryRun: true })).rejects.toThrow(/auth tag|Unsupported state|decrypt/i)
  })

  it('restore fails with clear error on mismatched SHA-256', async () => {
    const ts = Date.now()
    const user = db.insert(users)
      .values({
        id: `test-sha-user-${ts}`,
        email: `sha-${ts}@example.com`,
        name: 'SHA Test',
        createdAt: ts,
      })
      .returning()
      .get()

    const result = await runBackup()

    const encrypted = await memoryStore.get(result.key)
    const fakeSha = '0'.repeat(64)
    await memoryStore.put(result.key, encrypted, { 'sha256-plain': fakeSha })

    await expect(restoreBackup(result.key, { dryRun: true })).rejects.toThrow(/SHA-256 mismatch/)
  })

  it('round-trip: backup → corrupt → restore recovers data', async () => {
    const ts = Date.now()
    const userIds: string[] = []
    const itemIds: string[] = []

    // Seed: 3 users + 10 items
    for (let i = 0; i < 3; i++) {
      const user = db.insert(users)
        .values({
          id: `test-rt-user-${i}-${ts}`,
          email: `rt${i}-${ts}@example.com`,
          name: `RoundTrip User ${i}`,
          createdAt: ts,
        })
        .returning()
        .get()
      userIds.push(user.id)

      for (let j = 0; j < 3; j++) {
        const item = db.insert(items)
          .values({
            id: `test-rt-item-${i}-${j}-${ts}`,
            userId: user.id,
            imageUri: `images/items/rt-${i}-${j}.jpg`,
            category: 'tops',
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
          .get()
        itemIds.push(item.id)
      }
    }

    // Verify initial data
    const dbPath = join(DATA_DIR, 'closet.db')
    const originalSha256 = createHash('sha256').update(readFileSync(dbPath)).digest('hex')

    // Create backup
    const result = await runBackup()
    expect(result.key).toMatch(/^db\/\d{4}-\d{2}-\d{2}\/closet-\d{6}\.db\.enc$/)

    // Close the sqlite handle (better-sqlite3 holds a file descriptor)
    const sqlite = getSqlite()
    sqlite.close()
    resetDbForTesting()

    // Corrupt the DB file (overwrite first 4KB with zeros)
    const walPath = join(DATA_DIR, 'closet.db-wal')
    const shmPath = join(DATA_DIR, 'closet.db-shm')

    const fd = openSync(dbPath, 'r+')
    const zeros = Buffer.alloc(4096)
    writeSync(fd, zeros, 0, 4096, 0)
    closeSync(fd)

    // Delete WAL/SHM if present
    if (existsSync(walPath)) unlinkSync(walPath)
    if (existsSync(shmPath)) unlinkSync(shmPath)

    // Restore from backup (non-dry-run)
    const restoreResult = await restoreBackup(result.key)

    expect(restoreResult.verifiedChecksum).toBe(true)
    expect(restoreResult.restoredTo).toBe(dbPath)
    expect(restoreResult.preRestoreCopy).toBeDefined()
    expect(existsSync(restoreResult.preRestoreCopy!)).toBe(true)

    // Re-open DB and verify data
    const reopenedSqlite = getSqlite()

    const userCount = reopenedSqlite.prepare("SELECT COUNT(*) as c FROM users WHERE id LIKE 'test-rt-user-%'").get() as { c: number }
    expect(userCount.c).toBe(3)

    const itemCount = reopenedSqlite.prepare("SELECT COUNT(*) as c FROM items WHERE id LIKE 'test-rt-item-%'").get() as { c: number }
    expect(itemCount.c).toBe(9)

    const sampleUser = reopenedSqlite.prepare("SELECT * FROM users WHERE email = ?").get(`rt1-${ts}@example.com`) as { name: string } | undefined
    expect(sampleUser).toBeDefined()
    expect(sampleUser!.name).toBe('RoundTrip User 1')

    // Clean up test data
    for (const id of userIds) {
      reopenedSqlite.prepare('DELETE FROM items WHERE user_id = ?').run(id)
      reopenedSqlite.prepare('DELETE FROM users WHERE id = ?').run(id)
    }

    // Clean up pre-restore copy
    if (existsSync(restoreResult.preRestoreCopy!)) {
      unlinkSync(restoreResult.preRestoreCopy!)
    }
  })
})
