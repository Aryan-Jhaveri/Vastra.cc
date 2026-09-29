import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { DATA_DIR } from '../../src/db/client.js'
import { setStoreForTesting, type BackupObject, type BackupStoreInterface, type HeadResult, type PutResult } from '../../src/backups/r2.js'
import { restoreMissingImages, syncImagesIncremental } from '../../src/backups/images.js'

// #260 — per-file encrypted image backups: incremental, retry-safe, and a
// restore that only fills in missing files and can't write outside users/.

class MemoryStore implements BackupStoreInterface {
  objects = new Map<string, { body: Buffer; metadata?: Record<string, string>; lastModified: Date }>()
  failOn: string | null = null
  puts = 0
  async put(key: string, body: Buffer, metadata?: Record<string, string>): Promise<PutResult> {
    if (this.failOn && key.includes(this.failOn)) throw new Error('network down')
    this.puts++
    this.objects.set(key, { body, metadata, lastModified: new Date() })
    return { etag: 'x', size: body.length }
  }
  async get(key: string) { return this.objects.get(key)!.body }
  async head(key: string): Promise<HeadResult | null> {
    const o = this.objects.get(key)
    return o ? { size: o.body.length, lastModified: o.lastModified, metadata: o.metadata } : null
  }
  async list(prefix: string): Promise<BackupObject[]> {
    return [...this.objects].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, size: o.body.length, lastModified: o.lastModified }))
  }
  async delete(key: string) { this.objects.delete(key) }
}

const U = 'user_imgbak'
const users = join(DATA_DIR, 'users', U)
const stateFile = join(DATA_DIR, '.image-backup-state.json')
let store: MemoryStore
const savedSecret = process.env.BACKUP_ENCRYPTION_SECRET

function file(rel: string, content: string, ageMs = 0) {
  const abs = join(users, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
  if (ageMs) { const t = new Date(Date.now() - ageMs); utimesSync(abs, t, t) }
  return abs
}

beforeEach(() => {
  process.env.BACKUP_ENCRYPTION_SECRET = randomBytes(32).toString('base64')
  rmSync(join(DATA_DIR, 'users'), { recursive: true, force: true })
  rmSync(stateFile, { force: true })
  store = new MemoryStore()
  setStoreForTesting(store)
})
afterEach(() => { setStoreForTesting(null) })
afterAll(() => {
  rmSync(stateFile, { force: true })
  if (savedSecret === undefined) delete process.env.BACKUP_ENCRYPTION_SECRET
  else process.env.BACKUP_ENCRYPTION_SECRET = savedSecret
})

describe('syncImagesIncremental', () => {
  it('first run uploads every image encrypted; the next run uploads only what changed', async () => {
    const DAY = 86_400_000
    file('images/items/a.jpg', 'AAAA', 2 * DAY)
    file('images/items/a_thumb.jpg', 'aa', 2 * DAY)
    file('images/user/me.jpg', 'ME', 2 * DAY)

    const first = await syncImagesIncremental()
    expect(first).toMatchObject({ uploaded: 3, failed: 0, full: true })
    const obj = store.objects.get(`images/users/${U}/images/items/a.jpg.enc`)!
    expect(obj.body.includes(Buffer.from('AAAA'))).toBe(false)
    expect(obj.metadata?.['sha256-plain']).toMatch(/^[0-9a-f]{64}$/)

    file('images/items/b.jpg', 'NEW')
    const second = await syncImagesIncremental()
    expect(second).toMatchObject({ uploaded: 1, skipped: 3, full: false })
  })

  it('a failed upload keeps the state, so the file is retried next run', async () => {
    file('images/items/a.jpg', 'A', 86_400_000)
    store.failOn = 'a.jpg'
    expect((await syncImagesIncremental()).failed).toBe(1)
    expect(existsSync(stateFile)).toBe(false)
    store.failOn = null
    expect((await syncImagesIncremental())).toMatchObject({ uploaded: 1, failed: 0 })
  })
})

describe('restoreMissingImages', () => {
  it('dry run counts; apply writes back only missing files, byte for byte', async () => {
    file('images/items/a.jpg', 'ORIGINAL-A')
    file('images/items/b.jpg', 'ORIGINAL-B')
    await syncImagesIncremental()
    rmSync(join(users, 'images/items/a.jpg'))
    writeFileSync(join(users, 'images/items/b.jpg'), 'LOCAL-EDIT')

    expect(await restoreMissingImages({ apply: false })).toMatchObject({ wouldRestore: 1, present: 1, restored: 0 })
    expect(existsSync(join(users, 'images/items/a.jpg'))).toBe(false)

    expect(await restoreMissingImages({ apply: true, userId: U })).toMatchObject({ restored: 1, present: 1, failed: 0 })
    expect(readFileSync(join(users, 'images/items/a.jpg'), 'utf8')).toBe('ORIGINAL-A')
    expect(readFileSync(join(users, 'images/items/b.jpg'), 'utf8')).toBe('LOCAL-EDIT')
  })

  it('refuses a key that would write outside users/<id>/images/, and a tampered hash', async () => {
    file('images/items/a.jpg', 'A')
    await syncImagesIncremental()
    const good = store.objects.get(`images/users/${U}/images/items/a.jpg.enc`)!
    store.objects.set('images/../../escape.txt.enc', good)
    rmSync(join(users, 'images/items/a.jpg'))
    good.metadata = { 'sha256-plain': '0'.repeat(64) }

    const r = await restoreMissingImages({ apply: true })
    expect(r.failed).toBe(2)
    expect(r.restored).toBe(0)
    expect(existsSync(join(DATA_DIR, '..', 'escape.txt'))).toBe(false)
    expect(existsSync(join(users, 'images/items/a.jpg'))).toBe(false)
  })
})
