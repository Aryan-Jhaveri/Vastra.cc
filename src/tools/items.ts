import * as queries from '../db/queries.js'
import { saveImage, saveImageFromBase64, deleteImage } from '../storage/images.js'
import { normalizeColor } from '../constants/colors.js'
import { normalizeTags } from '../lib/normalizeTags.js'
import type { Item, AddItemInput, ListItemsInput, UpdateItemInput } from '../types/index.js'
import { like, desc, eq, and, sql, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { items } from '../db/schema.js'

export async function addItem(input: AddItemInput, userId: string): Promise<{ item: Item }> {
  queries.requireUserId(userId)
  let imageUri: string

  if (input.imagePath) {
    imageUri = await saveImage(input.imagePath, 'items', userId)
  } else if (input.imageBase64) {
    imageUri = await saveImageFromBase64(input.imageBase64, 'items', userId)
  } else {
    throw new Error('addItem requires either imagePath or imageBase64')
  }

  const item = queries.insertItem({
    userId,
    imageUri,
    category: input.category ?? 'tops',
    subcategory: input.subcategory,
    primaryColor: input.primaryColor ? normalizeColor(input.primaryColor) : undefined,
    colors: JSON.stringify((input.colors ?? []).map(normalizeColor)),
    material: input.material,
    careInstructions: JSON.stringify(input.careInstructions ?? []),
    brand: input.brand,
    size: input.size,
    season: JSON.stringify(input.season ?? []),
    tags: JSON.stringify(normalizeTags(input.tags)),
    aiDescription: input.aiDescription,
    occasion: JSON.stringify(normalizeTags(input.occasion)),
    wearContext: input.wearContext ?? undefined,
  })

  return { item }
}

export async function listItems(input: ListItemsInput = {}, userId: string): Promise<Item[]> {
  queries.requireUserId(userId)
  const conditions = [eq(items.userId, userId)]

  if (input.categories?.length) {
    conditions.push(input.categories.length === 1
      ? eq(items.category, input.categories[0])
      : inArray(items.category, input.categories))
  } else if (input.category) {
    conditions.push(eq(items.category, input.category))
  }
  if (input.color) conditions.push(like(items.colors, `%${input.color}%`))
  if (input.season) conditions.push(like(items.season, `%${input.season}%`))
  if (input.occasion) conditions.push(like(items.occasion, `%${input.occasion}%`))
  if (input.brand) conditions.push(eq(items.brand, input.brand))
  if (input.subcategory) conditions.push(eq(items.subcategory, input.subcategory))
  if (input.material) conditions.push(like(items.material, `%${input.material}%`))
  if (input.tags?.length) {
    for (const tag of input.tags) {
      conditions.push(like(items.tags, `%${tag}%`))
    }
  }

  let query = db.select().from(items).$dynamic()

  if (conditions.length) {
    query = query.where(and(...conditions))
  }

  query = query.orderBy(desc(items.createdAt))

  if (input.limit) {
    query = query.limit(input.limit)
  }
  if (input.offset) {
    query = query.offset(input.offset)
  }

  return query.all() as Item[]
}

export async function countItems(input: Omit<ListItemsInput, 'limit' | 'offset' | 'sortBy'> = {}, userId: string): Promise<number> {
  queries.requireUserId(userId)
  const conditions = [eq(items.userId, userId)]

  if (input.categories?.length) {
    conditions.push(input.categories.length === 1
      ? eq(items.category, input.categories[0])
      : inArray(items.category, input.categories))
  } else if (input.category) {
    conditions.push(eq(items.category, input.category))
  }
  if (input.color) conditions.push(like(items.colors, `%${input.color}%`))
  if (input.season) conditions.push(like(items.season, `%${input.season}%`))
  if (input.occasion) conditions.push(like(items.occasion, `%${input.occasion}%`))
  if (input.brand) conditions.push(eq(items.brand, input.brand))
  if (input.subcategory) conditions.push(eq(items.subcategory, input.subcategory))
  if (input.material) conditions.push(like(items.material, `%${input.material}%`))
  if (input.tags?.length) {
    for (const tag of input.tags) {
      conditions.push(like(items.tags, `%${tag}%`))
    }
  }

  let query = db.select({ count: sql<number>`count(*)` }).from(items).$dynamic()

  if (conditions.length) {
    query = query.where(and(...conditions))
  }

  const result = query.get()
  return (result as { count: number } | undefined)?.count ?? 0
}

export interface ItemCardData {
  id: string
  imageUri: string
  category: string
  subcategory: string | null
  primaryColor: string | null
  colors: string
  brand: string | null
  size: string | null
}

export async function listItemCards(input: ListItemsInput = {}, userId: string): Promise<ItemCardData[]> {
  queries.requireUserId(userId)
  const conditions = [eq(items.userId, userId)]

  if (input.categories?.length) {
    conditions.push(input.categories.length === 1
      ? eq(items.category, input.categories[0])
      : inArray(items.category, input.categories))
  } else if (input.category) {
    conditions.push(eq(items.category, input.category))
  }
  if (input.color) conditions.push(like(items.colors, `%${input.color}%`))
  if (input.season) conditions.push(like(items.season, `%${input.season}%`))
  if (input.occasion) conditions.push(like(items.occasion, `%${input.occasion}%`))
  if (input.brand) conditions.push(eq(items.brand, input.brand))
  if (input.subcategory) conditions.push(eq(items.subcategory, input.subcategory))
  if (input.material) conditions.push(like(items.material, `%${input.material}%`))
  if (input.tags?.length) {
    for (const tag of input.tags) {
      conditions.push(like(items.tags, `%${tag}%`))
    }
  }

  let query = db.select({
    id: items.id,
    imageUri: items.imageUri,
    category: items.category,
    subcategory: items.subcategory,
    primaryColor: items.primaryColor,
    colors: items.colors,
    brand: items.brand,
    size: items.size,
  }).from(items).$dynamic()

  if (conditions.length) {
    query = query.where(and(...conditions))
  }

  query = query.orderBy(desc(items.createdAt))

  if (input.limit) {
    query = query.limit(input.limit)
  }
  if (input.offset) {
    query = query.offset(input.offset)
  }

  return query.all() as ItemCardData[]
}

export async function getItem(id: string, userId: string): Promise<Item | null> {
  return queries.getItem(id, userId) ?? null
}

export async function updateItem(id: string, data: Omit<UpdateItemInput, 'id'>, userId: string): Promise<Item> {
  const patch: Record<string, unknown> = { ...data }

  if (data.colors !== undefined) patch.colors = JSON.stringify(data.colors.map(normalizeColor))
  if (data.careInstructions !== undefined) patch.careInstructions = JSON.stringify(data.careInstructions)
  if (data.season !== undefined) patch.season = JSON.stringify(data.season)
  if (data.tags !== undefined) patch.tags = JSON.stringify(normalizeTags(data.tags))
  if (data.occasion !== undefined) patch.occasion = JSON.stringify(normalizeTags(data.occasion))
  if (data.primaryColor !== undefined) patch.primaryColor = data.primaryColor === null ? null : normalizeColor(data.primaryColor)

  const updated = queries.updateItem(id, userId, patch as Parameters<typeof queries.updateItem>[2])
  if (!updated) throw new Error(`Item ${id} not found`)
  return updated
}

export async function deleteItem(id: string, userId: string): Promise<void> {
  const item = queries.getItem(id, userId)
  if (item) {
    await deleteImage(item.imageUri, userId)
    if (item.tagImageUri) await deleteImage(item.tagImageUri, userId)
  }
  queries.deleteItem(id, userId)
}

export async function searchItems(query: string, userId: string): Promise<Item[]> {
  return queries.searchItems(query, userId)
}

export async function markWorn(id: string, userId: string): Promise<Item> {
  const updated = queries.markItemWorn(id, userId)
  if (!updated) throw new Error(`Item ${id} not found`)
  return updated
}
