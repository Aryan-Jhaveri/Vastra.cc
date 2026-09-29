import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { gzipSync } from 'zlib'
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  IMPORT_OFFLINE_ENV,
  WEB_LIVE_ENV,
  assertImportAllowed,
  createTimestampedBackup,
  importPaths,
  integrityCheck,
  safeImportDatabase,
  writeSqliteAtomically,
} from '../../src/db/safeImport.mjs'

const tmpDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'closet-safe-import-'))
  tmpDirs.push(dir)
  return dir
}

function createDb(path: string, value: string): void {
  const db = new Database(path)
  db.exec('CREATE TABLE marker (value TEXT NOT NULL)')
  db.prepare('INSERT INTO marker (value) VALUES (?)').run(value)
  db.close()
}

function readMarker(path: string): string {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    return db.prepare('SELECT value FROM marker').pluck().get() as string
  } finally {
    db.close()
  }
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('safe DB import helpers', () => {
  it('short-circuits when the live-service signal is set', async () => {
    const dataDir = await tempDir()

    await expect(assertImportAllowed({
      dataDir,
      env: { [WEB_LIVE_ENV]: '1', [IMPORT_OFFLINE_ENV]: '1' },
    })).rejects.toThrow(WEB_LIVE_ENV)
  })

  it('requires an explicit offline env gate', async () => {
    const dataDir = await tempDir()

    await expect(assertImportAllowed({ dataDir, env: {} })).rejects.toThrow(IMPORT_OFFLINE_ENV)
  })

  it('writes a gzip source atomically and passes integrity check', async () => {
    const dataDir = await tempDir()
    const sourceDb = join(dataDir, 'source.db')
    const sourceGz = join(dataDir, 'source.db.gz')
    const destination = join(dataDir, 'closet.db')
    createDb(sourceDb, 'new')
    await writeFile(sourceGz, gzipSync(await readFile(sourceDb)))

    await writeSqliteAtomically({ sourcePath: sourceGz, destinationPath: destination })

    expect(readMarker(destination)).toBe('new')
    expect(integrityCheck(destination)).toEqual({ ok: true, messages: ['ok'] })
  })

  it('rotates timestamped backups when names collide', async () => {
    const dataDir = await tempDir()
    const dbPath = join(dataDir, 'closet.db')
    createDb(dbPath, 'original')
    const now = new Date('2026-06-22T03:04:05.000Z')

    const first = await createTimestampedBackup(dbPath, now)
    const second = await createTimestampedBackup(dbPath, now)

    expect(first).toMatch(/closet\.db\.bak\.20260622T030405Z$/)
    expect(second).toBe(`${first}.1`)
    await expect(stat(first)).resolves.toBeTruthy()
    await expect(stat(second)).resolves.toBeTruthy()
  })

  it('imports safely, removes WAL files, and creates a backup before overwrite', async () => {
    const dataDir = await tempDir()
    const { dbPath, walPath, shmPath } = importPaths(dataDir)
    const sourceDb = join(dataDir, 'source.db')
    createDb(dbPath, 'old')
    createDb(sourceDb, 'new')
    await writeFile(walPath, 'stale wal')
    await writeFile(shmPath, 'stale shm')

    const result = await safeImportDatabase({
      sourcePath: sourceDb,
      dataDir,
      env: { [IMPORT_OFFLINE_ENV]: '1' },
      now: new Date('2026-06-22T03:04:05.000Z'),
    })

    expect(result.ok).toBe(true)
    expect(readMarker(dbPath)).toBe('new')
    expect(readMarker(result.backupPath)).toBe('old')
    await expect(stat(walPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(shmPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(integrityCheck(dbPath)).toEqual({ ok: true, messages: ['ok'] })
  })

  it('restores the backup when the imported DB fails integrity check', async () => {
    const dataDir = await tempDir()
    const { dbPath } = importPaths(dataDir)
    const badSource = join(dataDir, 'bad.db')
    createDb(dbPath, 'old')
    await writeFile(badSource, 'not sqlite')

    await expect(safeImportDatabase({
      sourcePath: badSource,
      dataDir,
      env: { [IMPORT_OFFLINE_ENV]: '1' },
      now: new Date('2026-06-22T03:04:05.000Z'),
    })).rejects.toThrow('restored backup')

    expect(readMarker(dbPath)).toBe('old')
    expect(integrityCheck(dbPath)).toEqual({ ok: true, messages: ['ok'] })
  })
})
