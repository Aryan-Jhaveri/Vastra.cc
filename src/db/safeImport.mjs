import Database from 'better-sqlite3'
import { createReadStream, createWriteStream } from 'fs'
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat } from 'fs/promises'
import { basename, dirname, join, resolve } from 'path'
import { pipeline } from 'stream/promises'
import { createGunzip } from 'zlib'

export const LIVE_LOCKFILE = 'closet.web.lock'
export const IMPORT_OFFLINE_ENV = 'CLOSET_IMPORT_OFFLINE'
export const WEB_LIVE_ENV = 'CLOSET_WEB_LIVE'

export function importPaths(dataDir) {
  const resolvedDataDir = resolve(dataDir)
  const dbPath = join(resolvedDataDir, 'closet.db')
  return {
    dataDir: resolvedDataDir,
    dbPath,
    walPath: `${dbPath}-wal`,
    shmPath: `${dbPath}-shm`,
    lockPath: join(resolvedDataDir, LIVE_LOCKFILE),
  }
}

export async function assertImportAllowed({ dataDir, env = process.env } = {}) {
  if (env[WEB_LIVE_ENV] === '1' || env[WEB_LIVE_ENV] === 'true') {
    throw new Error(`${WEB_LIVE_ENV} is set; stop the web service before importing`)
  }
  if (env[IMPORT_OFFLINE_ENV] !== '1') {
    throw new Error(`${IMPORT_OFFLINE_ENV}=1 is required after stopping the web service`)
  }

  const { lockPath } = importPaths(dataDir)
  try {
    const contents = await readFile(lockPath, 'utf8')
    throw new Error(`web service lock exists at ${lockPath}: ${contents.trim()}`)
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err
  }
}

export async function fsyncFile(path) {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function fsyncDir(path) {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function createTimestampedBackup(dbPath, now = new Date()) {
  await stat(dbPath)
  const dataDir = dirname(dbPath)
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const base = join(dataDir, `${basename(dbPath)}.bak.${stamp}`)
  let backupPath = base
  for (let i = 1; ; i++) {
    try {
      await stat(backupPath)
      backupPath = `${base}.${i}`
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err
      break
    }
  }
  await copyFile(dbPath, backupPath)
  await fsyncFile(backupPath)
  await fsyncDir(dataDir)
  return backupPath
}

export async function listBackups(dataDir) {
  const entries = await readdir(dataDir)
  return entries
    .filter(name => name.startsWith('closet.db.bak.'))
    .sort()
    .map(name => join(dataDir, name))
}

export async function removeWalFiles(dbPath) {
  await Promise.all([
    rm(`${dbPath}-wal`, { force: true }),
    rm(`${dbPath}-shm`, { force: true }),
  ])
}

export function integrityCheck(dbPath) {
  let db
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const rows = db.prepare('PRAGMA integrity_check').all()
    const messages = rows.map(row => String(row.integrity_check ?? Object.values(row)[0] ?? ''))
    return {
      ok: messages.length === 1 && messages[0] === 'ok',
      messages,
    }
  } catch (err) {
    return { ok: false, messages: [err.message] }
  } finally {
    db?.close()
  }
}

export async function writeSqliteAtomically({ sourcePath, destinationPath }) {
  const dataDir = dirname(destinationPath)
  const tempPath = join(dataDir, `.${basename(destinationPath)}.import-${process.pid}-${Date.now()}.tmp`)
  try {
    const input = createReadStream(sourcePath)
    const output = createWriteStream(tempPath, { flags: 'wx' })
    if (await isGzip(sourcePath)) {
      await pipeline(input, createGunzip(), output)
    } else {
      await pipeline(input, output)
    }
    await fsyncFile(tempPath)
    await rename(tempPath, destinationPath)
    await fsyncDir(dataDir)
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => {})
    throw err
  }
}

export async function safeImportDatabase({ sourcePath, dataDir, env = process.env, now = new Date() }) {
  if (!sourcePath) throw new Error('sourcePath is required')
  const paths = importPaths(dataDir)
  await mkdir(paths.dataDir, { recursive: true })
  await assertImportAllowed({ dataDir: paths.dataDir, env })

  const backupPath = await createTimestampedBackup(paths.dbPath, now)
  await removeWalFiles(paths.dbPath)

  try {
    await writeSqliteAtomically({ sourcePath, destinationPath: paths.dbPath })
    const integrity = integrityCheck(paths.dbPath)
    if (!integrity.ok) {
      throw new Error(`integrity_check failed: ${integrity.messages.join('; ')}`)
    }
    return { ok: true, backupPath, dbPath: paths.dbPath }
  } catch (err) {
    await removeWalFiles(paths.dbPath)
    await copyFile(backupPath, paths.dbPath)
    await fsyncFile(paths.dbPath)
    await fsyncDir(paths.dataDir)
    throw new Error(`${err.message}; restored backup ${backupPath}`)
  }
}

async function isGzip(path) {
  if (path.endsWith('.gz')) return true
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(2)
    const result = await handle.read(buffer, 0, 2, 0)
    return result.bytesRead === 2 && buffer[0] === 0x1f && buffer[1] === 0x8b
  } finally {
    await handle.close()
  }
}
