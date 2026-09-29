import { db, DATA_DIR } from '../db/client.js'
import { users, items, tryonResults } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { join } from 'path'
import { existsSync } from 'fs'

export interface IntegrityResult {
  userId: string
  total: number
  missing: number
  missingPaths: string[]
}

function resolvePath(userId: string, imageUri: string): string | null {
  const userRel = join(DATA_DIR, 'users', userId, imageUri)
  if (existsSync(userRel)) return userRel
  if (userId === 'self') {
    const legacyRel = join(DATA_DIR, imageUri)
    if (existsSync(legacyRel)) return legacyRel
  }
  return null
}

export function checkImageIntegrity(userId?: string): IntegrityResult[] {
  const results: IntegrityResult[] = []

  const allUsers = userId
    ? db.select().from(users).where(eq(users.id, userId)).all()
    : db.select().from(users).all()

  for (const user of allUsers) {
    const userItems = db.select().from(items)
      .where(eq(items.userId, user.id))
      .all()

    const missingPaths: string[] = []

    for (const item of userItems) {
      if (resolvePath(user.id, item.imageUri)) continue
      missingPaths.push(item.imageUri)
    }

    if (missingPaths.length > 0) {
      console.log(`[integrity] ${user.id}: ${missingPaths.length}/${userItems.length} items have missing image files`)
      const first10 = missingPaths.slice(0, 10)
      for (const p of first10) {
        console.log(`[integrity]   missing: ${user.id}/${p}`)
      }
    }

    results.push({
      userId: user.id,
      total: userItems.length,
      missing: missingPaths.length,
      missingPaths,
    })
  }

  return results
}

export function checkTryonIntegrity(userId?: string): IntegrityResult[] {
  const results: IntegrityResult[] = []

  const allUsers = userId
    ? db.select().from(users).where(eq(users.id, userId)).all()
    : db.select().from(users).all()

  for (const user of allUsers) {
    const userResults = db.select().from(tryonResults)
      .where(eq(tryonResults.userId, user.id))
      .all()

    const missingPaths: string[] = []

    for (const result of userResults) {
      if (resolvePath(user.id, result.resultImageUri)) continue
      missingPaths.push(result.resultImageUri)
    }

    if (missingPaths.length > 0) {
      console.log(`[integrity-tryon] ${user.id}: ${missingPaths.length}/${userResults.length} tryon results have missing image files`)
      const first10 = missingPaths.slice(0, 10)
      for (const p of first10) {
        console.log(`[integrity-tryon]   missing: ${user.id}/${p}`)
      }
    }

    results.push({
      userId: user.id,
      total: userResults.length,
      missing: missingPaths.length,
      missingPaths,
    })
  }

  return results
}
