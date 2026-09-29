export const LIVE_LOCKFILE: string
export const IMPORT_OFFLINE_ENV: string
export const WEB_LIVE_ENV: string

export function importPaths(dataDir: string): {
  dataDir: string
  dbPath: string
  walPath: string
  shmPath: string
  lockPath: string
}

export function assertImportAllowed(options?: {
  dataDir?: string
  env?: Record<string, string | undefined>
}): Promise<void>

export function fsyncFile(path: string): Promise<void>
export function fsyncDir(path: string): Promise<void>
export function createTimestampedBackup(dbPath: string, now?: Date): Promise<string>
export function listBackups(dataDir: string): Promise<string[]>
export function removeWalFiles(dbPath: string): Promise<void>
export function integrityCheck(dbPath: string): { ok: boolean; messages: string[] }
export function writeSqliteAtomically(options: { sourcePath: string; destinationPath: string }): Promise<void>
export function safeImportDatabase(options: {
  sourcePath: string
  dataDir: string
  env?: Record<string, string | undefined>
  now?: Date
}): Promise<{ ok: true; backupPath: string; dbPath: string }>
