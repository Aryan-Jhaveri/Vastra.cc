import { readdir, stat, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { join, relative, sep } from 'path'
import { Cron } from 'croner'
import { DATA_DIR, getSqlite } from '../db/client.js'

// #362 — orphaned-image sweep. Deleting or replacing an image elsewhere may
// leave files behind (ephemeral try-on garments by design, older bugs, crashed
// uploads), so storage only ever grew. This walks users/<id>/images/, finds
// files no DB row references, and deletes the ones older than a grace period.
//
// Safety:
// - References are collected across ALL users: URIs carry random ids, so a
//   global set can only over-protect, never delete a live file.
// - A file is kept if it, or the full image its _thumb belongs to, is
//   referenced; and anything younger than the grace period is kept (uploads in
//   flight, share snapshots being written).
// - Only users/<id>/images/ is swept; the legacy DATA_DIR/images tree is not.
// - Nightly image backups (#260) never delete remote copies, so a swept file
//   stays recoverable.

export const DEFAULT_GRACE_DAYS = 30
/** Monthly, 04:30 UTC on the 1st (after the nightly backup window). */
export const IMAGE_SWEEP_CRON = '30 4 1 * *'

/** Every column that stores an image URI, as SQL returning one text column. */
const REFERENCE_QUERIES = [
  'SELECT image_uri AS uri FROM items',
  'SELECT tag_image_uri AS uri FROM items WHERE tag_image_uri IS NOT NULL',
  'SELECT image_uri AS uri FROM item_images',
  'SELECT cover_image_uri AS uri FROM outfits WHERE cover_image_uri IS NOT NULL',
  'SELECT cover_image_uri AS uri FROM collections WHERE cover_image_uri IS NOT NULL',
  'SELECT image_uri AS uri FROM user_photos',
  'SELECT result_image_uri AS uri FROM tryon_results',
  'SELECT output_image_uri AS uri FROM ai_calls WHERE output_image_uri IS NOT NULL',
]

function normaliseUri(uri: string): string {
  return uri.replace(/^\/+/, '').split('?')[0]
}

/** Every image URI any row references (relative, e.g. images/items/abc.jpg). */
export function referencedImageUris(): Set<string> {
  const db = getSqlite()
  const refs = new Set<string>()
  for (const sql of REFERENCE_QUERIES) {
    for (const row of db.prepare(sql).all() as Array<{ uri: string | null }>) {
      if (row.uri) refs.add(normaliseUri(row.uri))
    }
  }
  // Share snapshots: a JSON array per payload.
  for (const row of db.prepare('SELECT image_uris AS uris FROM share_payloads').all() as Array<{ uris: string | null }>) {
    try {
      for (const uri of JSON.parse(row.uris ?? '[]') as unknown[]) if (typeof uri === 'string') refs.add(normaliseUri(uri))
    } catch { /* malformed row: its files stay (they are only ever over-protected by being unknown) */ }
  }
  return refs
}

/** "images/items/a_thumb.jpg" → "images/items/a.jpg"; null when not a thumb. */
function fullImageOfThumb(uri: string): string | null {
  const m = /^(.*)_thumb(\.[^./]+)?$/.exec(uri)
  return m ? `${m[1]}${m[2] ?? ''}` : null
}

export interface SweepUserReport { userId: string; orphans: number; bytes: number; deleted: number }
export interface SweepReport {
  applied: boolean
  graceDays: number
  users: SweepUserReport[]
  orphans: number
  bytes: number
  deleted: number
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

export async function sweepOrphanImages(opts: { apply: boolean; graceDays?: number; now?: number; userId?: string } ): Promise<SweepReport> {
  const graceDays = opts.graceDays ?? DEFAULT_GRACE_DAYS
  const cutoff = (opts.now ?? Date.now()) - graceDays * 86_400_000
  const usersRoot = join(DATA_DIR, 'users')
  const report: SweepReport = { applied: opts.apply, graceDays, users: [], orphans: 0, bytes: 0, deleted: 0 }
  if (!existsSync(usersRoot)) return report

  // Taken once, before listing files: a file saved after this point is newer
  // than the grace cutoff anyway.
  const refs = referencedImageUris()
  const userIds = opts.userId ? [opts.userId] : (await readdir(usersRoot, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name)

  for (const userId of userIds) {
    if (!userId || userId.includes('..') || userId.includes(sep)) continue
    const userRoot = join(usersRoot, userId)
    const files: string[] = []
    await walk(join(userRoot, 'images'), files)
    const row: SweepUserReport = { userId, orphans: 0, bytes: 0, deleted: 0 }
    for (const abs of files) {
      const uri = relative(userRoot, abs).split(sep).join('/')
      if (refs.has(uri)) continue
      const full = fullImageOfThumb(uri)
      if (full && refs.has(full)) continue
      const info = await stat(abs).catch(() => null)
      if (!info || info.mtimeMs > cutoff) continue
      row.orphans++
      row.bytes += info.size
      if (opts.apply) {
        await unlink(abs).then(() => { row.deleted++ }, () => {})
      }
    }
    if (row.orphans) report.users.push(row)
    report.orphans += row.orphans
    report.bytes += row.bytes
    report.deleted += row.deleted
  }
  return report
}

export function formatSweepReport(r: SweepReport): string {
  const mb = (b: number) => `${(b / 1_048_576).toFixed(1)} MB`
  const head = `${r.applied ? 'Deleted' : 'Would delete'} ${r.applied ? r.deleted : r.orphans} orphaned image file(s), ${mb(r.bytes)} (unreferenced for ${r.graceDays}+ days)`
  return [head, ...r.users.map(u => `  ${u.userId}: ${u.orphans} file(s), ${mb(u.bytes)}`)].join('\n')
}

let sweepCron: Cron | null = null

/**
 * Monthly sweep. IMAGE_SWEEP=apply (default) deletes; =report only logs;
 * =off disables. IMAGE_SWEEP_GRACE_DAYS overrides the 30-day grace.
 */
export function initImageSweepCron(): void {
  const mode = (process.env.IMAGE_SWEEP ?? 'apply').trim().toLowerCase()
  if (mode === 'off') return
  const graceDays = Number(process.env.IMAGE_SWEEP_GRACE_DAYS) > 0 ? Number(process.env.IMAGE_SWEEP_GRACE_DAYS) : DEFAULT_GRACE_DAYS
  sweepCron?.stop()
  sweepCron = new Cron(IMAGE_SWEEP_CRON, { timezone: 'UTC', protect: true }, async () => {
    try {
      const report = await sweepOrphanImages({ apply: mode === 'apply', graceDays })
      console.log(`[image-sweep] ${formatSweepReport(report)}`)
    } catch (err) {
      console.error('[image-sweep] failed:', (err as Error).message)
    }
  })
  console.log(`[image-sweep] Scheduled monthly (${IMAGE_SWEEP_CRON} UTC, ${mode}, ${graceDays}-day grace)`)
}
