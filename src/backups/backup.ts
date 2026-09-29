import { createHash, randomBytes } from 'crypto'
import { tmpdir } from 'os'
import { readFileSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { getSqlite } from '../db/client.js'
import { encryptBuffer } from './encryption.js'
import { getStore } from './r2.js'

const RETENTION_DAYS = 30
const BACKUP_CRON = process.env.BACKUP_CRON ?? '0 3 * * *'

export { BACKUP_CRON }

export interface BackupResult {
  key: string
  sizeBytes: number
  durationMs: number
  sha256Plain: string
}

export async function runBackup(): Promise<BackupResult> {
  const start = Date.now()
  const store = getStore()

  const now = new Date()
  const dateStr = now.toISOString().slice(0, 10)
  const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '')
  const key = `db/${dateStr}/closet-${timeStr}.db.enc`

  const tmpPath = join(tmpdir(), `closet-backup-${randomBytes(8).toString('hex')}.db`)

  try {
    const db = getSqlite()
    await db.backup(tmpPath)

    const plainBuffer = readFileSync(tmpPath)
    const sha256Plain = createHash('sha256').update(plainBuffer).digest('hex')

    const encryptedBuffer = encryptBuffer(plainBuffer)

    await store.put(key, encryptedBuffer, { 'sha256-plain': sha256Plain })

    const durationMs = Date.now() - start

    console.log(
      JSON.stringify({
        timestamp: now.toISOString(),
        key,
        sizeBytes: encryptedBuffer.length,
        durationMs,
        sha256Plain,
      })
    )

    await pruneOldBackups(store)

    return { key, sizeBytes: encryptedBuffer.length, durationMs, sha256Plain }
  } finally {
    if (existsSync(tmpPath)) {
      unlinkSync(tmpPath)
    }
  }
}

async function pruneOldBackups(store: ReturnType<typeof getStore>): Promise<void> {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS)

  const objects = await store.list('db/', 1000)

  for (const obj of objects) {
    if (obj.lastModified < cutoff) {
      try {
        await store.delete(obj.key)
        console.log(JSON.stringify({ timestamp: new Date().toISOString(), deleted: obj.key }))
      } catch (err) {
        console.error(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            error: `Failed to delete ${obj.key}: ${err}`,
          })
        )
      }
    }
  }
}
