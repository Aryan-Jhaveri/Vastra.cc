import { describe, it, expect, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { db } from '../../src/db/client.js'
import { users, items, tryonResults } from '../../src/db/schema.js'
import { eq } from 'drizzle-orm'
import { checkImageIntegrity, checkTryonIntegrity } from '../../src/storage/integrityCheck.js'

const DATA_DIR = process.env.CLOSET_DATA_DIR!

function ensureUser(id: string, email: string) {
  const existing = db.select().from(users).where(eq(users.id, id)).get()
  if (!existing) {
    db.insert(users).values({ id, email, createdAt: Date.now() }).run()
  }
}

function createRealFile(userId: string, imageUri: string) {
  const absPath = join(DATA_DIR, 'users', userId, imageUri)
  mkdirSync(join(absPath, '..'), { recursive: true })
  writeFileSync(absPath, 'fake jpeg data')
}

function insertTestItem(itemId: string, userId: string, imageUri: string) {
  db.insert(items).values({
    id: itemId,
    userId,
    imageUri,
    category: 'tops',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }).run()
}

function insertTestTryonResult(resultId: string, userId: string, resultImageUri: string) {
  db.insert(tryonResults).values({
    id: resultId,
    userId,
    userPhotoId: 'photo-1',
    itemIds: '["item-1"]',
    resultImageUri,
    createdAt: Date.now(),
  }).run()
}

beforeEach(() => {
  db.delete(items).run()
  db.delete(tryonResults).run()
})

describe('checkImageIntegrity', () => {
  it('reports zero missing when all files exist', () => {
    const userId = 'integ-a'
    ensureUser(userId, 'intega@test.com')

    const uri = 'images/items/exists.jpg'
    createRealFile(userId, uri)
    insertTestItem('item-1', userId, uri)

    const results = checkImageIntegrity(userId)
    expect(results).toHaveLength(1)
    expect(results[0].userId).toBe(userId)
    expect(results[0].total).toBe(1)
    expect(results[0].missing).toBe(0)
    expect(results[0].missingPaths).toHaveLength(0)
  })

  it('reports missing files correctly', () => {
    const userId = 'integ-b'
    ensureUser(userId, 'integB@test.com')

    const uri1 = 'images/items/exists.jpg'
    createRealFile(userId, uri1)
    insertTestItem('item-a', userId, uri1)

    const uri2 = 'images/items/missing.jpg'
    insertTestItem('item-b', userId, uri2)

    const results = checkImageIntegrity(userId)
    expect(results).toHaveLength(1)
    expect(results[0].total).toBe(2)
    expect(results[0].missing).toBe(1)
    expect(results[0].missingPaths).toEqual([uri2])
  })

  it('handles legacy self user fallback', () => {
    const userId = 'self'
    ensureUser(userId, 'self@local.closet')

    const uri = 'images/items/legacy-file.jpg'
    const legacyAbs = join(DATA_DIR, uri)
    mkdirSync(join(legacyAbs, '..'), { recursive: true })
    writeFileSync(legacyAbs, 'legacy jpeg data')
    insertTestItem('item-legacy', userId, uri)

    const results = checkImageIntegrity(userId)
    expect(results).toHaveLength(1)
    expect(results[0].missing).toBe(0)
  })

  it('handles multiple users', () => {
    const u1 = 'integ-m1'
    const u2 = 'integ-m2'
    ensureUser(u1, 'm1@test.com')
    ensureUser(u2, 'm2@test.com')

    const uri1 = 'images/items/a.jpg'
    const uri2 = 'images/items/b.jpg'
    createRealFile(u1, uri1)
    insertTestItem('m1-item', u1, uri1)

    insertTestItem('m2-item', u2, uri2)

    const results = checkImageIntegrity()
    const r1 = results.find(r => r.userId === u1)
    const r2 = results.find(r => r.userId === u2)

    expect(r1).toBeDefined()
    expect(r2).toBeDefined()
    expect(r1!.missing).toBe(0)
    expect(r2!.missing).toBe(1)
    expect(r2!.missingPaths).toEqual([uri2])
  })

  it('returns empty array for unknown userId', () => {
    const results = checkImageIntegrity('nonexistent-user')
    expect(results).toHaveLength(0)
  })
})

describe('checkTryonIntegrity', () => {
  it('reports zero missing when all files exist', () => {
    const userId = 'tryon-a'
    ensureUser(userId, 'tryona@test.com')

    const uri = 'images/tryon/exists.jpg'
    createRealFile(userId, uri)
    insertTestTryonResult('tr-1', userId, uri)

    const results = checkTryonIntegrity(userId)
    expect(results).toHaveLength(1)
    expect(results[0].userId).toBe(userId)
    expect(results[0].total).toBe(1)
    expect(results[0].missing).toBe(0)
    expect(results[0].missingPaths).toHaveLength(0)
  })

  it('reports missing files correctly', () => {
    const userId = 'tryon-b'
    ensureUser(userId, 'tryonb@test.com')

    const uri1 = 'images/tryon/on-disk.jpg'
    createRealFile(userId, uri1)
    insertTestTryonResult('tr-a', userId, uri1)

    const uri2 = 'images/tryon/gone.jpg'
    insertTestTryonResult('tr-b', userId, uri2)

    const results = checkTryonIntegrity(userId)
    expect(results).toHaveLength(1)
    expect(results[0].total).toBe(2)
    expect(results[0].missing).toBe(1)
    expect(results[0].missingPaths).toEqual([uri2])
  })

  it('handles legacy self user fallback', () => {
    const userId = 'self'
    ensureUser(userId, 'self@local.closet')

    const uri = 'images/tryon/legacy-result.jpg'
    const legacyAbs = join(DATA_DIR, uri)
    mkdirSync(join(legacyAbs, '..'), { recursive: true })
    writeFileSync(legacyAbs, 'legacy jpeg data')
    insertTestTryonResult('tr-legacy', userId, uri)

    const results = checkTryonIntegrity(userId)
    expect(results).toHaveLength(1)
    expect(results[0].missing).toBe(0)
  })

  it('handles multiple users with cross-user isolation', () => {
    const u1 = 'tryon-m1'
    const u2 = 'tryon-m2'
    ensureUser(u1, 'tryon-m1@test.com')
    ensureUser(u2, 'tryon-m2@test.com')

    const uri1 = 'images/tryon/ok.jpg'
    const uri2 = 'images/tryon/broken.jpg'
    createRealFile(u1, uri1)
    insertTestTryonResult('tr-m1', u1, uri1)
    insertTestTryonResult('tr-m2', u2, uri2)

    const results = checkTryonIntegrity()
    const r1 = results.find(r => r.userId === u1)
    const r2 = results.find(r => r.userId === u2)

    expect(r1).toBeDefined()
    expect(r2).toBeDefined()
    expect(r1!.missing).toBe(0)
    expect(r2!.missing).toBe(1)
    expect(r2!.missingPaths).toEqual([uri2])
  })

  it('returns empty array for unknown userId', () => {
    const results = checkTryonIntegrity('nonexistent-user')
    expect(results).toHaveLength(0)
  })

  it('does not cross-contaminate: user A scan excludes user B rows', () => {
    const userId = 'tryon-iso'
    ensureUser(userId, 'iso@test.com')

    const uri = 'images/tryon/iso-file.jpg'
    createRealFile(userId, uri)
    insertTestTryonResult('tr-iso-ok', userId, uri)

    const otherUser = 'tryon-iso-other'
    ensureUser(otherUser, 'iso-other@test.com')
    insertTestTryonResult('tr-iso-other-missing', otherUser, 'images/tryon/other-gone.jpg')

    const results = checkTryonIntegrity(userId)
    expect(results).toHaveLength(1)
    expect(results[0].userId).toBe(userId)
    expect(results[0].total).toBe(1)
    expect(results[0].missing).toBe(0)
  })
})
