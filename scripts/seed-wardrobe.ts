#!/usr/bin/env tsx
/**
 * Seed 30 diverse wardrobe items + 10 outfits for a given user.
 *
 * Downloads real fashion images from Picsum (generic) or LoremFlickr (keyword-matched),
 * inserts items + outfits directly into the DB, and optionally triggers AI thumbnail gen.
 *
 * Usage:
 *   npm run seed:wardrobe
 *   SEED_USER_ID=<id> npm run seed:wardrobe
 *   GENERATE_THUMBNAILS=true WEB_AUTH_PASSWORD=xxx npm run seed:wardrobe
 *
 * Env:
 *   SEED_USER_ID         target userId (default: 'self')
 *   GENERATE_THUMBNAILS  'true' → run AI thumbnail gen (~480 tokens total)
 *   WEB_AUTH_PASSWORD    required when GENERATE_THUMBNAILS=true
 *   API_URL              default: http://localhost:3000
 */

import 'dotenv/config'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync, writeFileSync } from 'fs'
import sharp from 'sharp'
import { createHmac } from 'crypto'
import { db, getSqlite } from '../src/db/client.js'
import { reconcileMigrations } from '../src/db/reconcileMigrations.js'
import { items, outfits } from '../src/db/schema.js'
import { nanoid } from 'nanoid'

const __dirname = dirname(fileURLToPath(import.meta.url))

const SEED_USER_ID = process.env.SEED_USER_ID ?? 'self'
const GENERATE_THUMBNAILS = process.env.GENERATE_THUMBNAILS === 'true'
const API_URL = process.env.API_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.WEB_AUTH_PASSWORD ?? ''
const DATA_DIR =
  process.env.CLOSET_DATA_DIR ?? join(homedir(), '.closet')

// ── Console colours ────────────────────────────────────────────────────────

function cyan(s: string) { return `\x1b[36m${s}\x1b[0m` }
function green(s: string) { return `\x1b[32m${s}\x1b[0m` }
function yellow(s: string) { return `\x1b[33m${s}\x1b[0m` }
function red(s: string) { return `\x1b[31m${s}\x1b[0m` }
function dim(s: string) { return `\x1b[2m${s}\x1b[0m` }

// ── Auth (admin bearer fallback) ───────────────────────────────────────────

function bearerToken() {
  return createHmac('sha256', 'closet-session-v1').update(PASSWORD).digest('hex')
}

// ── Image source: DummyJSON product photos ─────────────────────────────────

// DummyJSON serves free product photos with no auth required. Each item maps to
// a category — we pre-fetch the product pool per category and rotate through it.
type DummyProduct = { id: number; title: string; images: string[]; thumbnail: string }
const imagePool = new Map<string, string[]>()

async function fetchCategoryImages(category: string): Promise<string[]> {
  const cached = imagePool.get(category)
  if (cached) return cached
  const url = `https://dummyjson.com/products/category/${category}?limit=30&select=images,thumbnail`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`DummyJSON ${category}: HTTP ${res.status}`)
  const data = await res.json() as { products: DummyProduct[] }
  const urls = data.products
    .map(p => p.images?.[0] ?? p.thumbnail)
    .filter((u): u is string => Boolean(u))
  if (urls.length === 0) throw new Error(`DummyJSON ${category}: no images returned`)
  imagePool.set(category, urls)
  return urls
}

async function downloadAndSaveImage(id: string, sourceUrl: string): Promise<string> {
  const folder = join(DATA_DIR, 'users', SEED_USER_ID, 'images', 'items')
  mkdirSync(folder, { recursive: true })

  const res = await fetch(sourceUrl, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${sourceUrl}`)

  const raw = Buffer.from(await res.arrayBuffer())

  // Compress + normalise to 400×500 JPEG (source is often webp on a white bg —
  // `fit: 'contain'` keeps the whole garment visible instead of cropping it out).
  const compressed = await sharp(raw)
    .resize(400, 500, { fit: 'contain', background: { r: 245, g: 245, b: 245 } })
    .jpeg({ quality: 82 })
    .toBuffer()

  const filename = `${id}.jpg`
  writeFileSync(join(folder, filename), compressed)
  // Legacy-style path; server's tryResolve() checks per-user dir first.
  return `images/items/${filename}`
}

// ── Thumbnail generation (optional, calls live API) ────────────────────────

async function generateThumbnail(itemId: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/items/${itemId}/thumbnail`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearerToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Item definitions ───────────────────────────────────────────────────────

type ItemSeed = {
  name: string
  // DummyJSON category to pull the product image from
  srcCat: string
  category: string
  subcategory: string
  primaryColor: string
  colors: string[]
  season: string[]
  occasion: string[]
  tags: string[]
  material?: string
  formality: number
  aiDescription: string
}

const ITEMS: ItemSeed[] = [
  // ── Tops (7) — mens-shirts + tops (womens) mix ────────────────────────────
  { name: 'White Classic T-Shirt',      srcCat: 'mens-shirts',    category: 'tops',       subcategory: 'T-shirt',        primaryColor: 'white',     colors: ['white'],              season: ['spring','summer'],        occasion: ['casual','outdoor'],        tags: ['basic','cotton','everyday'],             material: 'cotton',          formality: 2, aiDescription: 'Classic white cotton crew-neck t-shirt.' },
  { name: 'Navy Oxford Shirt',          srcCat: 'mens-shirts',    category: 'tops',       subcategory: 'Oxford shirt',   primaryColor: 'navy',      colors: ['navy','blue'],         season: ['spring','fall'],          occasion: ['work','casual'],           tags: ['button-down','classic','professional'],   material: 'cotton',          formality: 3, aiDescription: 'Tailored navy blue Oxford button-down shirt.' },
  { name: 'Black Turtleneck',           srcCat: 'mens-shirts',    category: 'tops',       subcategory: 'Turtleneck',     primaryColor: 'black',     colors: ['black'],               season: ['fall','winter'],          occasion: ['casual','work','date'],    tags: ['minimal','versatile','knit'],            material: 'merino wool',     formality: 3, aiDescription: 'Sleek black merino turtleneck with a slim fit.' },
  { name: 'Navy Striped Shirt',         srcCat: 'mens-shirts',    category: 'tops',       subcategory: 'Striped shirt',  primaryColor: 'navy',      colors: ['navy','white'],        season: ['spring','summer'],        occasion: ['casual','work'],           tags: ['stripes','nautical','preppy'],           material: 'cotton',          formality: 3, aiDescription: 'Classic navy and white striped button-down.' },
  { name: 'Dusty Pink Floral Blouse',   srcCat: 'tops',           category: 'tops',       subcategory: 'Blouse',         primaryColor: 'pink',      colors: ['pink','white'],        season: ['spring','summer'],        occasion: ['casual','date'],           tags: ['floral','feminine','lightweight'],        material: 'chiffon',         formality: 2, aiDescription: 'Flowy dusty pink chiffon blouse with a floral print.' },
  { name: 'Gray Zip Hoodie',            srcCat: 'mens-shirts',    category: 'tops',       subcategory: 'Hoodie',         primaryColor: 'gray',      colors: ['gray'],                season: ['all'],                    occasion: ['casual'],                  tags: ['cozy','fleece','loungewear'],            material: 'cotton blend',    formality: 1, aiDescription: 'Mid-weight gray zip-up hoodie in a relaxed fit.' },
  { name: 'Cream Linen Shirt',          srcCat: 'tops',           category: 'tops',       subcategory: 'Linen shirt',    primaryColor: 'cream',     colors: ['cream','white'],       season: ['spring','summer'],        occasion: ['casual','work','outdoor'], tags: ['linen','breathable','relaxed'],          material: 'linen',           formality: 2, aiDescription: 'Breezy cream linen button-up, rolled sleeves.' },

  // ── Bottoms (6) — DummyJSON has no bottoms category; use mens-shirts + tops ──
  { name: 'Dark Wash Slim Jeans',       srcCat: 'mens-shirts',    category: 'bottoms',    subcategory: 'Jeans',          primaryColor: 'dark blue', colors: ['dark blue','blue'],    season: ['all'],                    occasion: ['casual','date','work'],    tags: ['denim','slim','versatile'],             material: 'denim',           formality: 2, aiDescription: 'Dark wash slim-fit jeans, five-pocket style.' },
  { name: 'Khaki Chinos',               srcCat: 'mens-shirts',    category: 'bottoms',    subcategory: 'Chinos',         primaryColor: 'khaki',     colors: ['khaki','beige'],       season: ['spring','summer','fall'], occasion: ['casual','work','outdoor'], tags: ['chinos','preppy','smart-casual'],        material: 'cotton twill',    formality: 3, aiDescription: 'Slim-fit khaki chinos with a tapered leg.' },
  { name: 'Black Slim Trousers',        srcCat: 'mens-shirts',    category: 'bottoms',    subcategory: 'Trousers',       primaryColor: 'black',     colors: ['black'],               season: ['all'],                    occasion: ['work','formal','date'],    tags: ['dress pants','office','versatile'],      material: 'wool blend',      formality: 4, aiDescription: 'Tailored black slim-cut trousers.' },
  { name: 'Blush Floral Midi Skirt',    srcCat: 'womens-dresses', category: 'bottoms',    subcategory: 'Midi skirt',     primaryColor: 'pink',      colors: ['pink','white'],        season: ['spring','summer'],        occasion: ['casual','date'],           tags: ['floral','feminine','flowy'],             material: 'satin',           formality: 2, aiDescription: 'Flowy satin midi skirt in blush with a floral print.' },
  { name: 'Heather Gray Joggers',       srcCat: 'sports-accessories', category: 'bottoms', subcategory: 'Joggers',       primaryColor: 'gray',      colors: ['gray'],                season: ['all'],                    occasion: ['casual'],                  tags: ['joggers','comfortable','loungewear'],    material: 'french terry',    formality: 1, aiDescription: 'Cozy heather gray joggers, tapered leg.' },
  { name: 'White Linen Shorts',         srcCat: 'mens-shirts',    category: 'bottoms',    subcategory: 'Shorts',         primaryColor: 'white',     colors: ['white','cream'],       season: ['spring','summer'],        occasion: ['casual','outdoor'],        tags: ['linen','beach','summer'],               material: 'linen',           formality: 1, aiDescription: 'Loose-fit white linen shorts.' },

  // ── Dresses (3) ───────────────────────────────────────────────────────────
  { name: 'Little Black Dress',         srcCat: 'womens-dresses', category: 'dresses',    subcategory: 'Mini dress',     primaryColor: 'black',     colors: ['black'],               season: ['fall','winter'],          occasion: ['formal','date','work'],    tags: ['LBD','classic','versatile','elegant'],   material: 'crepe',           formality: 4, aiDescription: 'Timeless LBD in crepe with a sleeveless scoop neck.' },
  { name: 'Peach Floral Sundress',      srcCat: 'womens-dresses', category: 'dresses',    subcategory: 'Sundress',       primaryColor: 'peach',     colors: ['peach','orange','white'], season: ['spring','summer'],       occasion: ['casual','outdoor','date'], tags: ['floral','sundress','breezy','romantic'],  material: 'cotton',          formality: 2, aiDescription: 'Breezy peach sundress with a floral print.' },
  { name: 'Rust Wrap Midi Dress',       srcCat: 'womens-dresses', category: 'dresses',    subcategory: 'Wrap dress',     primaryColor: 'rust',      colors: ['rust','orange'],       season: ['fall','winter'],          occasion: ['casual','work','date'],    tags: ['wrap','midi','autumnal','flattering'],   material: 'jersey',          formality: 3, aiDescription: 'Flattering rust wrap midi dress in jersey.' },

  // ── Outerwear (4) — DummyJSON has no coat category; use mens-shirts ────────
  { name: 'Black Wool Peacoat',         srcCat: 'mens-shirts',    category: 'outerwear',  subcategory: 'Peacoat',        primaryColor: 'black',     colors: ['black'],               season: ['fall','winter'],          occasion: ['casual','work','formal'],  tags: ['wool','classic','double-breasted'],      material: 'wool',            formality: 4, aiDescription: 'Classic black double-breasted wool peacoat.' },
  { name: 'Medium Wash Denim Jacket',   srcCat: 'mens-shirts',    category: 'outerwear',  subcategory: 'Denim jacket',   primaryColor: 'blue',      colors: ['blue','denim'],        season: ['spring','fall'],          occasion: ['casual','outdoor'],        tags: ['denim','casual','layering','americana'], material: 'denim',           formality: 2, aiDescription: 'Medium-wash denim jacket, trucker style.' },
  { name: 'Khaki Trench Coat',          srcCat: 'mens-shirts',    category: 'outerwear',  subcategory: 'Trench coat',    primaryColor: 'khaki',     colors: ['khaki','beige'],       season: ['fall','winter'],          occasion: ['work','casual','formal'],  tags: ['trench','classic','belted'],             material: 'cotton gabardine', formality: 3, aiDescription: 'Timeless belted khaki trench coat.' },
  { name: 'White Puffer Jacket',        srcCat: 'mens-shirts',    category: 'outerwear',  subcategory: 'Puffer jacket',  primaryColor: 'white',     colors: ['white'],               season: ['winter'],                 occasion: ['outdoor','casual'],        tags: ['puffer','warm','winter','insulated'],    material: 'nylon shell',     formality: 1, aiDescription: 'Warm white puffer jacket with a quilted pattern.' },

  // ── Shoes (5) ─────────────────────────────────────────────────────────────
  { name: 'White Leather Sneakers',     srcCat: 'mens-shoes',     category: 'shoes',      subcategory: 'Sneakers',       primaryColor: 'white',     colors: ['white'],               season: ['spring','summer'],        occasion: ['casual','outdoor'],        tags: ['sneakers','clean','minimal','leather'],  material: 'leather',         formality: 2, aiDescription: 'Clean white leather low-top sneakers.' },
  { name: 'Tan Leather Loafers',        srcCat: 'mens-shoes',     category: 'shoes',      subcategory: 'Loafers',        primaryColor: 'tan',       colors: ['tan','brown'],         season: ['all'],                    occasion: ['work','casual'],           tags: ['loafers','leather','smart-casual'],      material: 'leather',         formality: 3, aiDescription: 'Classic tan leather penny loafers.' },
  { name: 'Black Chelsea Boots',        srcCat: 'mens-shoes',     category: 'shoes',      subcategory: 'Chelsea boots',  primaryColor: 'black',     colors: ['black'],               season: ['fall','winter'],          occasion: ['casual','work','date'],    tags: ['boots','chelsea','leather','versatile'], material: 'leather',         formality: 3, aiDescription: 'Sleek black leather Chelsea boots.' },
  { name: 'Nude Block Heels',           srcCat: 'womens-shoes',   category: 'shoes',      subcategory: 'Block heels',    primaryColor: 'nude',      colors: ['nude','beige'],        season: ['all'],                    occasion: ['work','formal','date'],    tags: ['heels','block heel','nude','feminine'],  material: 'suede',           formality: 4, aiDescription: 'Nude suede block-heel pumps, 3-inch heel.' },
  { name: 'Gray Trail Running Shoes',   srcCat: 'mens-shoes',     category: 'shoes',      subcategory: 'Running shoes',  primaryColor: 'gray',      colors: ['gray','black'],        season: ['all'],                    occasion: ['outdoor','casual'],        tags: ['running','athletic','trail'],            material: 'mesh',            formality: 1, aiDescription: 'Lightweight gray trail running shoes.' },

  // ── Accessories (4) ───────────────────────────────────────────────────────
  { name: 'Brown Leather Belt',         srcCat: 'mens-watches',   category: 'accessories', subcategory: 'Belt',           primaryColor: 'brown',     colors: ['brown'],               season: ['all'],                    occasion: ['casual','work','formal'],  tags: ['leather','belt','classic','essential'],  material: 'leather',         formality: 3, aiDescription: 'Full-grain brown leather belt with a silver buckle.' },
  { name: 'Silver Minimalist Watch',    srcCat: 'mens-watches',   category: 'accessories', subcategory: 'Watch',          primaryColor: 'silver',    colors: ['silver','white'],      season: ['all'],                    occasion: ['casual','work','formal','date'], tags: ['watch','silver','minimalist','timeless'], material: 'stainless steel', formality: 4, aiDescription: 'Minimalist silver watch, mesh bracelet.' },
  { name: 'Cream Canvas Tote',          srcCat: 'womens-bags',    category: 'accessories', subcategory: 'Tote bag',       primaryColor: 'cream',     colors: ['cream','beige'],       season: ['spring','summer'],        occasion: ['casual','outdoor','work'], tags: ['tote','canvas','casual','everyday'],     material: 'canvas',          formality: 1, aiDescription: 'Spacious cream canvas tote with sturdy handles.' },
  { name: 'Ivory Silk Scarf',           srcCat: 'womens-jewellery', category: 'accessories', subcategory: 'Scarf',        primaryColor: 'ivory',     colors: ['ivory','white'],       season: ['all'],                    occasion: ['casual','formal','date'],  tags: ['silk','scarf','elegant','versatile'],    material: 'silk',            formality: 3, aiDescription: 'Ivory silk square scarf with a fine woven texture.' },

  // ── Activewear (1) ────────────────────────────────────────────────────────
  { name: 'Black Compression Leggings', srcCat: 'sports-accessories', category: 'activewear', subcategory: 'Leggings',    primaryColor: 'black',     colors: ['black'],               season: ['all'],                    occasion: ['casual'],                  tags: ['leggings','workout','stretch','activewear'], material: 'spandex blend', formality: 1, aiDescription: 'High-waisted black compression leggings.' },
]

// ── Outfit definitions ─────────────────────────────────────────────────────

type OutfitSeed = {
  name: string
  occasion: string
  season: string[]
  tags: string[]
  notes: string
  itemNames: string[]
}

const OUTFITS: OutfitSeed[] = [
  { name: 'Casual Friday',       occasion: 'casual',   season: ['all'],            tags: ['casual','everyday'],               notes: 'Clean and effortless for errands or a relaxed day out.',        itemNames: ['White Classic T-Shirt','Dark Wash Slim Jeans','White Leather Sneakers','Brown Leather Belt'] },
  { name: 'Office Ready',        occasion: 'work',     season: ['all'],            tags: ['professional','classic'],           notes: 'Sharp for client meetings and presentations.',                   itemNames: ['Navy Oxford Shirt','Black Slim Trousers','Tan Leather Loafers','Silver Minimalist Watch'] },
  { name: 'Weekend Brunch',      occasion: 'casual',   season: ['spring','summer'], tags: ['feminine','brunch'],              notes: 'Light and fresh for a morning out.',                             itemNames: ['Dusty Pink Floral Blouse','Khaki Chinos','Nude Block Heels'] },
  { name: 'Date Night',          occasion: 'date',     season: ['fall','winter'],  tags: ['elegant','date','evening'],         notes: 'Classic and chic for a dinner date.',                           itemNames: ['Little Black Dress','Black Chelsea Boots','Silver Minimalist Watch'] },
  { name: 'Cozy Sunday',         occasion: 'casual',   season: ['all'],            tags: ['cozy','comfortable','lounge'],      notes: 'The ultimate lazy day look.',                                    itemNames: ['Gray Zip Hoodie','Heather Gray Joggers','White Leather Sneakers'] },
  { name: 'Spring Garden Party', occasion: 'casual',   season: ['spring','summer'], tags: ['romantic','garden','feminine'],   notes: 'Soft and floral for an outdoor gathering.',                      itemNames: ['Peach Floral Sundress','Nude Block Heels','Ivory Silk Scarf'] },
  { name: 'Weekend Explorer',    occasion: 'outdoor',  season: ['spring','fall'],  tags: ['casual','layered','outdoor'],       notes: 'Layered casual for a day exploring the city.',                   itemNames: ['Cream Linen Shirt','White Linen Shorts','Medium Wash Denim Jacket','White Leather Sneakers','Cream Canvas Tote'] },
  { name: 'Power Meeting',       occasion: 'work',     season: ['fall','winter'],  tags: ['power','minimalist','professional'], notes: 'Monochromatic black for maximum authority.',                  itemNames: ['Black Turtleneck','Black Slim Trousers','Nude Block Heels','Silver Minimalist Watch'] },
  { name: 'Autumn Stroll',       occasion: 'casual',   season: ['fall'],           tags: ['autumnal','layered','classic'],     notes: 'Classic layers for a crisp autumn day.',                         itemNames: ['Navy Striped Shirt','Dark Wash Slim Jeans','Black Chelsea Boots','Khaki Trench Coat'] },
  { name: 'Gym & Go',            occasion: 'casual',   season: ['all'],            tags: ['athletic','functional','minimal'],  notes: 'Functional activewear for a workout session.',                   itemNames: ['Black Compression Leggings','Gray Zip Hoodie','Gray Trail Running Shoes'] },
]

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  // Same migrator as server boot (#157): drizzle's migrate() skips low-`when` entries.
  reconcileMigrations(getSqlite(), join(__dirname, '..', 'src', 'db', 'migrations'))

  if (GENERATE_THUMBNAILS && !PASSWORD) {
    console.error(red('❌ WEB_AUTH_PASSWORD is required when GENERATE_THUMBNAILS=true'))
    process.exit(1)
  }

  console.log(cyan(`Seeding ${ITEMS.length} items + ${OUTFITS.length} outfits`))
  console.log(dim(`  userId: ${SEED_USER_ID}  |  data: ${DATA_DIR}`))
  console.log(dim('  Images: dummyjson.com product photos, mapped by category'))
  if (GENERATE_THUMBNAILS) {
    console.log(yellow(`  ⚠  GENERATE_THUMBNAILS=true — ~${ITEMS.length * 16} tokens`))
  }
  console.log()

  // ── Create items ──────────────────────────────────────────────────────────
  console.log(cyan('Downloading images + creating items...'))
  const idByName = new Map<string, string>()
  const catCursor = new Map<string, number>() // rotate through each category's pool

  for (let i = 0; i < ITEMS.length; i++) {
    const seed = ITEMS[i]
    const id = nanoid()

    let imageUri: string
    try {
      const urls = await fetchCategoryImages(seed.srcCat)
      const cursor = catCursor.get(seed.srcCat) ?? 0
      const sourceUrl = urls[cursor % urls.length]
      catCursor.set(seed.srcCat, cursor + 1)
      imageUri = await downloadAndSaveImage(id, sourceUrl)
    } catch (err) {
      console.log(yellow(`  [${String(i + 1).padStart(2)}] ⚠ image download failed for "${seed.name}": ${err} — skipping`))
      continue
    }

    db.insert(items).values({
      id,
      userId: SEED_USER_ID,
      imageUri,
      category: seed.category,
      subcategory: seed.subcategory,
      primaryColor: seed.primaryColor,
      colors: JSON.stringify(seed.colors),
      material: seed.material ?? null,
      season: JSON.stringify(seed.season),
      tags: JSON.stringify(seed.tags),
      aiDescription: seed.aiDescription,
      occasion: JSON.stringify(seed.occasion),
      formality: seed.formality,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }).run()

    idByName.set(seed.name, id)
    console.log(green(`  [${String(i + 1).padStart(2)}/${ITEMS.length}] ${seed.name} ${dim(`(${seed.category})`)}`))

    // Small delay to be a polite client to LoremFlickr
    await sleep(300)
  }

  console.log()

  // ── Thumbnails (optional) ─────────────────────────────────────────────────
  if (GENERATE_THUMBNAILS) {
    console.log(cyan('Generating AI thumbnails (2 s between calls)...'))
    let done = 0
    for (const [name, id] of Array.from(idByName.entries())) {
      try {
        await generateThumbnail(id)
        done++
        console.log(green(`  [${String(done).padStart(2)}/${idByName.size}] ✓ ${name}`))
      } catch (err) {
        console.log(yellow(`  [${String(done + 1).padStart(2)}/${idByName.size}] ⚠ skipped "${name}": ${err}`))
      }
      await sleep(2000)
    }
    console.log()
  }

  // ── Create outfits ────────────────────────────────────────────────────────
  console.log(cyan('Creating outfits...'))
  let outfitsDone = 0

  for (const outfit of OUTFITS) {
    const itemIds = outfit.itemNames
      .map(n => idByName.get(n))
      .filter((id): id is string => Boolean(id))

    if (itemIds.length === 0) {
      console.log(yellow(`  ⚠ skipped "${outfit.name}" — no matching items found`))
      continue
    }

    db.insert(outfits).values({
      id: nanoid(),
      userId: SEED_USER_ID,
      name: outfit.name,
      itemIds: JSON.stringify(itemIds),
      occasion: outfit.occasion,
      season: JSON.stringify(outfit.season),
      notes: outfit.notes,
      tags: JSON.stringify(outfit.tags),
      createdAt: Date.now(),
    }).run()

    outfitsDone++
    console.log(green(`  ${outfit.name} ${dim(`(${itemIds.length} items)`)}`))
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const totalItems = idByName.size
  console.log()
  console.log(green('✓ Done!'))
  console.log(`  ${cyan(String(totalItems))} items`)
  console.log(`  ${cyan(String(outfitsDone))} outfits`)
  if (GENERATE_THUMBNAILS) {
    console.log(`  ${cyan('AI thumbnails')} generated`)
  } else {
    console.log(dim('  Run with GENERATE_THUMBNAILS=true WEB_AUTH_PASSWORD=xxx to add AI thumbnails'))
  }
}

main().catch(err => {
  console.error(red('Seed failed:'), err)
  process.exit(1)
})
