#!/usr/bin/env tsx
/**
 * Dev seed script — creates a demo user with items + outfits + embeddings
 * so Suggest / Discover RRF work end-to-end without live AI calls.
 *
 * Idempotent: wipes the demo user and re-seeds on every run.
 * Requires MOCK_EMBEDDINGS=true and MOCK_AI_IMAGE_GEN=true for full offline dev.
 *
 * Usage: npm run seed:dev
 *
 * Credentials: demo@closet.local / demo
 */

import 'dotenv/config'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { db, getSqlite } from '../src/db/client.js'
import { reconcileMigrations } from '../src/db/reconcileMigrations.js'
import { items, outfits, embeddings, users } from '../src/db/schema.js'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import {
  saveEmbedding,
  IMAGE_EMBED_MODEL_VERSION,
  TEXT_EMBED_MODEL_VERSION,
  mockEmbeddingVector,
  isMockEmbeddings,
  centroid,
} from '../src/storage/embeddings.js'
import { textItemSourceBlob, textOutfitSourceBlob } from '../src/ai/embed.js'
import { hashPassword } from '../src/auth/password.js'
import { hostedHooks } from '../src/hostedHooks.js'
import { registerHostedHooks } from '../src/hosted/index.js'
import { isHostedMode } from '../src/hostedMode.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const DEMO_USER_ID = 'demo-user-seed'
const DEMO_EMAIL = 'demo@closet.local'

function cyan(s: string) { return `\x1b[36m${s}\x1b[0m` }
function green(s: string) { return `\x1b[32m${s}\x1b[0m` }
function yellow(s: string) { return `\x1b[33m${s}\x1b[0m` }

async function main() {
  if (isHostedMode()) registerHostedHooks()
  // Run migrations
  // Same migrator as server boot (#157): drizzle's migrate() skips low-`when` entries.
  reconcileMigrations(getSqlite(), join(__dirname, '..', 'src', 'db', 'migrations'))

  // ── Wipe demo user data ─────────────────────────────────────────────────
  console.log(cyan('Wiping existing demo data...'))
  db.delete(embeddings).where(eq(embeddings.userId, DEMO_USER_ID)).run()
  db.delete(outfits).where(eq(outfits.userId, DEMO_USER_ID)).run()
  db.delete(items).where(eq(items.userId, DEMO_USER_ID)).run()
  db.delete(users).where(eq(users.id, DEMO_USER_ID)).run()

  // ── Create demo user ─────────────────────────────────────────────────────
  console.log(cyan('Creating demo user...'))
  const passwordHash = hashPassword('demo')
  db.transaction((tx) => {
    tx.insert(users).values({
      id: DEMO_USER_ID,
      email: DEMO_EMAIL,
      name: 'Demo User',
      passwordHash,
      createdAt: Date.now(),
    }).run()
    hostedHooks().onUserCreated(tx, DEMO_USER_ID)
  })
  console.log(green(`  User: ${DEMO_EMAIL} / demo (id=${DEMO_USER_ID})`))

  // ── Create demo items ────────────────────────────────────────────────────
  console.log(cyan('Creating demo items...'))

  const demoItems = [
    { category: 'tops', subcategory: 't-shirt', primaryColor: 'white', colors: '["white"]', material: 'cotton', brand: 'Uniqlo', size: 'M', season: '["spring","summer"]', tags: '["casual","basic"]', aiDescription: 'Classic white cotton crew-neck t-shirt', occasion: '["casual"]', wearContext: 'Everyday basic layer' },
    { category: 'tops', subcategory: 'blouse', primaryColor: 'blue', colors: '["blue","white"]', material: 'silk', brand: 'Equipment', size: 'S', season: '["spring","fall"]', tags: '["work","elegant"]', aiDescription: 'Navy blue silk blouse with subtle pinstripe', occasion: '["work","dinner"]', wearContext: 'Office-to-evening staple' },
    { category: 'bottoms', subcategory: 'jeans', primaryColor: 'blue', colors: '["blue"]', material: 'denim', brand: 'Levi\'s', size: '32', season: '["fall","winter","spring"]', tags: '["casual","classic"]', aiDescription: 'Slim-fit dark wash denim jeans', occasion: '["casual"]', wearContext: 'Goes with everything' },
    { category: 'bottoms', subcategory: 'trousers', primaryColor: 'black', colors: '["black"]', material: 'wool', brand: 'Theory', size: 'M', season: '["fall","winter"]', tags: '["work","formal"]', aiDescription: 'Tailored black wool trousers with clean crease', occasion: '["work","formal"]', wearContext: 'Interview / boardroom staple' },
    { category: 'outerwear', subcategory: 'blazer', primaryColor: 'navy', colors: '["navy"]', material: 'wool', brand: 'J.Crew', size: 'M', season: '["fall","winter","spring"]', tags: '["work","smart-casual"]', aiDescription: 'Navy wool blazer with notch lapel', occasion: '["work","dinner"]', wearContext: 'Instant polish over any outfit' },
    { category: 'outerwear', subcategory: 'coat', primaryColor: 'camel', colors: '["camel"]', material: 'wool', brand: 'Max Mara', size: 'M', season: '["fall","winter"]', tags: '["classic","elegant"]', aiDescription: 'Camel wool wrap coat, knee-length', occasion: '["work","formal"]', wearContext: 'Cold-weather statement piece' },
    { category: 'footwear', subcategory: 'sneakers', primaryColor: 'white', colors: '["white","grey"]', material: 'leather', brand: 'Common Projects', size: '42', season: '["spring","summer","fall"]', tags: '["casual","minimal"]', aiDescription: 'White leather low-top sneakers with gold stamp', occasion: '["casual"]', wearContext: 'Minimalist everyday sneaker' },
    { category: 'footwear', subcategory: 'loafers', primaryColor: 'black', colors: '["black"]', material: 'leather', brand: 'Gucci', size: '42', season: '["spring","fall","winter"]', tags: '["work","formal"]', aiDescription: 'Black leather horsebit loafers', occasion: '["work","formal"]', wearContext: 'Dress shoe with heritage detail' },
    { category: 'accessories', subcategory: 'watch', primaryColor: 'silver', colors: '["silver","black"]', material: 'steel', brand: 'Cartier', size: 'ONE', season: '["spring","summer","fall","winter"]', tags: '["luxury","classic"]', aiDescription: 'Silver Tank watch with black leather strap', occasion: '["formal","dinner"]', wearContext: 'Signature timepiece' },
    { category: 'dresses', subcategory: 'midi', primaryColor: 'red', colors: '["red"]', material: 'silk', brand: 'Reformation', size: 'S', season: '["spring","summer"]', tags: '["date-night","elegant"]', aiDescription: 'Red silk midi dress with subtle cowl neck', occasion: '["dinner","party"]', wearContext: 'Summer evening showstopper' },
  ]

  const createdItemIds: string[] = []
  const fixtureUris: string[] = []

  for (let i = 0; i < demoItems.length; i++) {
    const item = demoItems[i]
    const id = nanoid()
    const imageUri = `images/items/${id}.jpg`
    fixtureUris.push(imageUri)

    db.insert(items).values({
      id,
      userId: DEMO_USER_ID,
      imageUri,
      category: item.category,
      subcategory: item.subcategory,
      primaryColor: item.primaryColor,
      colors: item.colors,
      material: item.material,
      brand: item.brand,
      size: item.size,
      season: item.season,
      tags: item.tags,
      aiDescription: item.aiDescription,
      occasion: item.occasion,
      wearContext: item.wearContext,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }).run()

    createdItemIds.push(id)
    console.log(green(`  Item ${i + 1}: ${item.category}/${item.subcategory} — ${item.primaryColor} (${id.slice(0, 8)}...)`))
  }

  // ── Pre-populate text embeddings for items ───────────────────────────────
  console.log(cyan('Generating text embeddings...'))
  for (const id of createdItemIds) {
    const item = db.select().from(items).where(eq(items.id, id)).get()!
    const blob = textItemSourceBlob(item)
    const vec = mockEmbeddingVector(blob, 1024)
    await saveEmbedding({
      level: 'item', refId: id, userId: DEMO_USER_ID, variant: 'main',
      modelVersion: TEXT_EMBED_MODEL_VERSION, vector: vec, sourceBlob: blob,
    })
  }
  console.log(green(`  ${createdItemIds.length} item text embeddings`))

  // ── Pre-populate image embeddings for items ──────────────────────────────
  console.log(cyan('Generating image embeddings...'))
  for (let i = 0; i < createdItemIds.length; i++) {
    const id = createdItemIds[i]
    const imageUri = fixtureUris[i]
    const vec = mockEmbeddingVector(Buffer.from(imageUri), 1408)
    await saveEmbedding({
      level: 'item', refId: id, userId: DEMO_USER_ID, variant: 'image',
      modelVersion: IMAGE_EMBED_MODEL_VERSION, vector: vec, sourceBlob: imageUri,
    })
  }
  console.log(green(`  ${createdItemIds.length} item image embeddings`))

  // ── Create demo outfits ──────────────────────────────────────────────────
  console.log(cyan('Creating demo outfits...'))

  // itemIndices reference the demoItems array above (0-based)
  const outfitDefs = [
    {
      name: 'Casual Friday',
      itemIndices: [0, 2, 6], // white tee + jeans + white sneakers
      occasion: 'casual',
      season: '["spring","summer"]',
      notes: 'Clean, effortless. Swap sneakers for loafers to dress it up.',
      tags: '["casual","minimal"]',
    },
    {
      name: 'Boardroom Ready',
      itemIndices: [3, 4, 7], // black trousers + navy blazer + black loafers
      occasion: 'work',
      season: '["fall","winter"]',
      notes: 'Sharp but not stuffy. Add the camel coat for cold commutes.',
      tags: '["work","formal"]',
    },
    {
      name: 'Date Night',
      itemIndices: [1, 3], // blue silk blouse + black tailored trousers
      occasion: 'dinner',
      season: '["spring","fall"]',
      notes: 'Silk blouse and tailored trousers — elegant and understated.',
      tags: '["date-night","elegant"]',
    },
    {
      name: 'Summer Evening',
      itemIndices: [9, 8], // red midi dress + silver watch
      occasion: 'party',
      season: '["spring","summer"]',
      notes: 'The red dress is the star. Minimal accessories let it shine.',
      tags: '["date-night","elegant","minimal"]',
    },
  ]

  for (const outfit of outfitDefs) {
    const outfitId = nanoid()
    const outfitItemIds = outfit.itemIndices.map(i => createdItemIds[i])

    db.insert(outfits).values({
      id: outfitId,
      userId: DEMO_USER_ID,
      name: outfit.name,
      itemIds: JSON.stringify(outfitItemIds),
      occasion: outfit.occasion,
      season: outfit.season,
      notes: outfit.notes,
      tags: outfit.tags,
      createdAt: Date.now(),
    }).run()

    // Text embedding
    const outfitRecord = { name: outfit.name, occasion: outfit.occasion, season: outfit.season, notes: outfit.notes, tags: outfit.tags }
    const textBlob = textOutfitSourceBlob(outfitRecord)
    const textVec = mockEmbeddingVector(textBlob, 1024)
    await saveEmbedding({
      level: 'outfit', refId: outfitId, userId: DEMO_USER_ID, variant: 'metadata',
      modelVersion: TEXT_EMBED_MODEL_VERSION, vector: textVec, sourceBlob: textBlob,
    })

    // Image centroid embedding (average of member items' image vectors)
    // Needed for Discover RRF image-mode matching against outfits.
    const itemImageVecs: Float32Array[] = []
    for (const itemId of outfitItemIds) {
      const idx = createdItemIds.indexOf(itemId)
      const itemVec = mockEmbeddingVector(Buffer.from(fixtureUris[idx]), 1408)
      itemImageVecs.push(itemVec)
    }
    if (itemImageVecs.length > 0) {
      const centroidVec = centroid(itemImageVecs)
      await saveEmbedding({
        level: 'outfit', refId: outfitId, userId: DEMO_USER_ID, variant: 'image_centroid',
        modelVersion: IMAGE_EMBED_MODEL_VERSION, vector: centroidVec,
        sourceBlob: outfitItemIds.join(','),
      })
    }

    console.log(green(`  Outfit: "${outfit.name}" (${outfitItemIds.length} items, id=${outfitId.slice(0, 8)}...)`))
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const itemCount = db.select().from(items).where(eq(items.userId, DEMO_USER_ID)).all().length
  const outfitCount = db.select().from(outfits).where(eq(outfits.userId, DEMO_USER_ID)).all().length
  const embedCount = db.select().from(embeddings).where(eq(embeddings.userId, DEMO_USER_ID)).all().length

  console.log()
  console.log(green('Seed complete!'))
  console.log(`  ${cyan(String(itemCount))} items`)
  console.log(`  ${cyan(String(outfitCount))} outfits`)
  console.log(`  ${cyan(String(embedCount))} embeddings`)
  console.log()
  if (!isMockEmbeddings()) {
    console.log(yellow('  ⚠  MOCK_EMBEDDINGS is not set — seed ran but used live Vertex calls if TEXT_EMBED_ENABLED or IMAGE_EMBED_ENABLED was on.'))
    console.log(yellow('     For offline dev, set MOCK_EMBEDDINGS=true in .env'))
  } else {
    console.log(green('  ✓ Verified: MOCK_EMBEDDINGS=true — all vectors are deterministic fixtures'))
  }
}

main().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
