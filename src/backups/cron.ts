import { Cron } from 'croner'
import { runBackup, BACKUP_CRON } from './backup.js'
import { syncImagesIncremental } from './images.js'

let backupCron: Cron | null = null

export function initBackupCron(): void {
  const secret = process.env.BACKUP_ENCRYPTION_SECRET

  if (!secret || Buffer.from(secret, 'base64').length !== 32) {
    console.error(
      '[backup] BACKUP_ENCRYPTION_SECRET missing or not exactly 32 bytes — backups disabled. ' +
        'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    )
    return
  }

  if (backupCron) {
    backupCron.stop()
  }

  backupCron = new Cron(BACKUP_CRON, { timezone: 'UTC' }, async () => {
    console.log('[backup] Starting nightly backup...')
    try {
      const result = await runBackup()
      console.log(`[backup] Completed: ${result.key} (${result.sizeBytes} bytes, ${result.durationMs}ms)`)
    } catch (err) {
      console.error('[backup] Failed:', err)
    }
    // Images after the DB (#260): incremental, independent of the DB result.
    try {
      const images = await syncImagesIncremental()
      console.log(`[backup] Images: ${images.uploaded} uploaded, ${images.skipped} unchanged, ${images.failed} failed${images.full ? ' (full sync)' : ''}`)
    } catch (err) {
      console.error('[backup] Image sync failed:', (err as Error).message)
    }
  })

  console.log(`[backup] Scheduled nightly backup cron: ${BACKUP_CRON} UTC`)
}

export function stopBackupCron(): void {
  if (backupCron) {
    backupCron.stop()
    backupCron = null
    console.log('[backup] Stopped backup cron')
  }
}
