import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { inArray } from 'drizzle-orm'
import { DATA_DIR, db } from '../../src/db/client.js'
import { items, itemImages, outfits, sharePayloads, tryonResults, userPhotos, users } from '../../src/db/schema.js'
import { formatSweepReport, sweepOrphanImages } from '../../src/storage/imageSweep.js'

// #362 — the sweep deletes only files that no row references AND that are
// older than the grace period; thumbs follow their full image.

const A = 'user_sweep_a'
const B = 'user_sweep_b'
const DAY = 86_400_000
const NOW = Date.now()

function file(userId: string, uri: string, ageDays: number) {
  const abs = join(DATA_DIR, 'users', userId, uri)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, Buffer.alloc(1024))
  const t = new Date(NOW - ageDays * DAY)
  utimesSync(abs, t, t)
  return abs
}
const has = (userId: string, uri: string) => existsSync(join(DATA_DIR, 'users', userId, uri))

beforeAll(() => {
  for (const id of [A, B]) db.insert(users).values({ id, email: `${id}@local.closet`, createdAt: NOW }).onConflictDoNothing().run()
})

beforeEach(() => {
  for (const id of [A, B]) rmSync(join(DATA_DIR, 'users', id), { recursive: true, force: true })
  db.delete(itemImages).where(inArray(itemImages.userId, [A, B])).run()
  db.delete(tryonResults).where(inArray(tryonResults.userId, [A, B])).run()
  db.delete(userPhotos).where(inArray(userPhotos.userId, [A, B])).run()
  db.delete(outfits).where(inArray(outfits.userId, [A, B])).run()
  db.delete(sharePayloads).where(inArray(sharePayloads.userId, [A, B])).run()
  db.delete(items).where(inArray(items.userId, [A, B])).run()

  db.insert(items).values({ id: 'sw_item', userId: A, imageUri: 'images/items/live.jpg', tagImageUri: 'images/tags/label.jpg', category: 'tops', createdAt: NOW, updatedAt: NOW }).run()
  db.insert(itemImages).values({ id: 'sw_view', itemId: 'sw_item', userId: A, imageUri: 'images/items/back.jpg', role: 'view', position: 1, isPrimary: 0, createdAt: NOW } as never).run()
  db.insert(outfits).values({ id: 'sw_outfit', userId: A, name: 'O', itemIds: '[]', coverImageUri: 'images/outfits/cover.jpg', createdAt: NOW }).run()
  db.insert(userPhotos).values({ id: 'sw_photo', userId: A, imageUri: 'images/user/me.jpg', createdAt: NOW }).run()
  db.insert(tryonResults).values({ id: 'sw_try', userId: A, userPhotoId: 'sw_photo', itemIds: '[]', resultImageUri: 'images/tryon/result.jpg', createdAt: NOW }).run()
  db.insert(sharePayloads).values({ id: 'sw_share', userId: A, createdAt: NOW, source: 'outfit', description: '', imageUris: JSON.stringify(['images/share/sw_share/a.jpg']) }).run()

  for (const uri of ['images/items/live.jpg', 'images/items/live_thumb.jpg', 'images/tags/label.jpg', 'images/items/back.jpg',
    'images/outfits/cover.jpg', 'images/user/me.jpg', 'images/tryon/result.jpg', 'images/share/sw_share/a.jpg']) file(A, uri, 90)
  file(A, 'images/garments/old-garment.jpg', 45)       // orphan, past grace
  file(A, 'images/items/gone.jpg', 40)                 // orphan, past grace
  file(A, 'images/items/gone_thumb.jpg', 40)           // its thumb: orphan too
  file(A, 'images/garments/fresh-garment.jpg', 2)      // orphan, inside grace
  file(B, 'images/items/b-orphan.jpg', 60)             // another user's orphan
})

afterAll(() => {
  for (const id of [A, B]) rmSync(join(DATA_DIR, 'users', id), { recursive: true, force: true })
})

describe('sweepOrphanImages', () => {
  it('dry run reports only old unreferenced files and deletes nothing', async () => {
    const r = await sweepOrphanImages({ apply: false, graceDays: 30, now: NOW })
    const a = r.users.find(u => u.userId === A)!
    expect(a.orphans).toBe(3)
    expect(a.bytes).toBe(3 * 1024)
    expect(r.users.find(u => u.userId === B)?.orphans).toBe(1)
    expect(r.deleted).toBe(0)
    expect(has(A, 'images/items/gone.jpg')).toBe(true)
    expect(formatSweepReport(r)).toMatch(/^Would delete \d+ orphaned image file/)
  })

  it('apply deletes the orphans and keeps every referenced file, its thumb, and recent files', async () => {
    const r = await sweepOrphanImages({ apply: true, graceDays: 30, now: NOW, userId: A })
    expect(r.deleted).toBe(3)
    for (const gone of ['images/garments/old-garment.jpg', 'images/items/gone.jpg', 'images/items/gone_thumb.jpg']) expect(has(A, gone)).toBe(false)
    for (const kept of ['images/items/live.jpg', 'images/items/live_thumb.jpg', 'images/tags/label.jpg', 'images/items/back.jpg',
      'images/outfits/cover.jpg', 'images/user/me.jpg', 'images/tryon/result.jpg', 'images/share/sw_share/a.jpg',
      'images/garments/fresh-garment.jpg']) expect(has(A, kept)).toBe(true)
    // Scoped to one user: B's orphan is untouched.
    expect(has(B, 'images/items/b-orphan.jpg')).toBe(true)
  })

  it('a shorter grace period catches newer orphans', async () => {
    const r = await sweepOrphanImages({ apply: false, graceDays: 1, now: NOW, userId: A })
    expect(r.users[0].orphans).toBe(4)
  })
})
