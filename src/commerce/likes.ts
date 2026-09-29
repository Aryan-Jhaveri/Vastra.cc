import { count, desc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { likedProducts } from '../db/schema.js'
import { requireUserId } from '../db/queries.js'

/** The user's liked product ids, newest first (ids only — the catalog is read live). */
export function listLikedProductIds(userId: string, limit: number): { ids: string[]; total: number } {
  requireUserId(userId)
  const [{ total }] = db.select({ total: count() }).from(likedProducts).where(eq(likedProducts.userId, userId)).all()
  const rows = db.select({ productId: likedProducts.productId }).from(likedProducts)
    .where(eq(likedProducts.userId, userId))
    .orderBy(desc(likedProducts.createdAt), desc(likedProducts.id))
    .limit(limit)
    .all()
  return { ids: rows.map(r => r.productId), total }
}
