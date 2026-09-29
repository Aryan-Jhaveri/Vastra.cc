import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'fs/promises'
import { dirname, join, relative, resolve, sep } from 'path'
import { DATA_DIR } from '../db/client.js'
import { decryptBuffer, encryptBuffer } from './encryption.js'
import { getStore } from './r2.js'

// #260 — off-host copies of every user image, next to the nightly DB backup.
// Each file under users/<id>/images/ is encrypted on its own (same key as the
// DB backups) and stored at `images/<path under DATA_DIR>.enc`. The sync is
// incremental: files modified since the last successful run are uploaded.
// Remote copies are never deleted, so an image the orphan sweep (#362) removes
// or a user deletes stays restorable. Restore only writes files that are
// missing locally; it never overwrites.

export const IMAGE_BACKUP_PREFIX = 'images/'
const STATE_FILE = '.image-backup-state.json'
/** Re-check files touched shortly before the last run started (clock skew, writes in flight). */
const OVERLAP_MS = 10 * 60_000

interface SyncState { lastSuccessStartedAt: number }

function statePath(): string {
  return join(DATA_DIR, STATE_FILE)
}

async function readState(): Promise<SyncState | null> {
  try {
    const parsed = JSON.parse(await readFile(statePath(), 'utf8')) as SyncState
    return Number.isFinite(parsed.lastSuccessStartedAt) ? parsed : null
  } catch {
    return null
  }
}

async function writeState(state: SyncState): Promise<void> {
  const tmp = `${statePath()}.tmp`
  await writeFile(tmp, JSON.stringify(state), { mode: 0o600 })
  await rename(tmp, statePath())
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const abs = join(dir, e.name)
    if (e.isDirectory()) await walk(abs, out)
    else if (e.isFile()) out.push(abs)
  }
}

/** Absolute paths of every image file under users/<id>/images/. */
async function listImageFiles(): Promise<string[]> {
  const usersRoot = join(DATA_DIR, 'users')
  if (!existsSync(usersRoot)) return []
  const files: string[] = []
  for (const d of await readdir(usersRoot, { withFileTypes: true })) {
    if (d.isDirectory()) await walk(join(usersRoot, d.name, 'images'), files)
  }
  return files
}

function keyFor(absPath: string): string {
  return `${IMAGE_BACKUP_PREFIX}${relative(DATA_DIR, absPath).split(sep).join('/')}.enc`
}

export interface ImageSyncResult { uploaded: number; skipped: number; failed: number; bytes: number; full: boolean }

/**
 * Uploads image files changed since the last successful sync (all of them on
 * the first run, or with `full`). The state only advances when nothing failed,
 * so a failed file is retried on the next run.
 */
export async function syncImagesIncremental(opts: { full?: boolean; now?: number } = {}): Promise<ImageSyncResult> {
  const startedAt = opts.now ?? Date.now()
  const state = opts.full ? null : await readState()
  const since = state ? state.lastSuccessStartedAt - OVERLAP_MS : -Infinity
  const store = getStore()
  const result: ImageSyncResult = { uploaded: 0, skipped: 0, failed: 0, bytes: 0, full: !state }

  for (const abs of await listImageFiles()) {
    const info = await stat(abs).catch(() => null)
    if (!info) continue
    if (info.mtimeMs < since) { result.skipped++; continue }
    try {
      const plain = await readFile(abs)
      const sha256 = createHash('sha256').update(plain).digest('hex')
      const body = encryptBuffer(plain)
      await store.put(keyFor(abs), body, { 'sha256-plain': sha256 })
      result.uploaded++
      result.bytes += body.length
    } catch (err) {
      result.failed++
      console.error(`[image-backup] ${relative(DATA_DIR, abs)}: ${(err as Error).message}`)
    }
  }

  if (!result.failed) await writeState({ lastSuccessStartedAt: startedAt })
  return result
}

export interface ImageRestoreResult { restored: number; present: number; failed: number; wouldRestore: number }

/**
 * Writes back backed-up images that are missing locally (optionally one
 * user's). Existing files are never overwritten. Each file is checked against
 * the plaintext hash stored with it before it's written.
 */
export async function restoreMissingImages(opts: { apply: boolean; userId?: string }): Promise<ImageRestoreResult> {
  const store = getStore()
  const prefix = opts.userId ? `${IMAGE_BACKUP_PREFIX}users/${opts.userId}/` : IMAGE_BACKUP_PREFIX
  const root = resolve(DATA_DIR, 'users')
  const result: ImageRestoreResult = { restored: 0, present: 0, failed: 0, wouldRestore: 0 }

  for (const obj of await store.list(prefix, Number.MAX_SAFE_INTEGER)) {
    if (!obj.key.endsWith('.enc')) continue
    const rel = obj.key.slice(IMAGE_BACKUP_PREFIX.length, -'.enc'.length)
    const target = resolve(DATA_DIR, rel)
    // Only ever inside users/<id>/images/: a crafted key can't write elsewhere.
    if (!target.startsWith(root + sep) || !rel.split('/').includes('images')) { result.failed++; continue }
    if (existsSync(target)) { result.present++; continue }
    if (!opts.apply) { result.wouldRestore++; continue }
    try {
      const plain = decryptBuffer(await store.get(obj.key))
      const expected = (await store.head(obj.key))?.metadata?.['sha256-plain']
      if (expected && createHash('sha256').update(plain).digest('hex') !== expected) throw new Error('hash mismatch')
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, plain)
      result.restored++
    } catch (err) {
      result.failed++
      console.error(`[image-restore] ${rel}: ${(err as Error).message}`)
    }
  }
  return result
}
