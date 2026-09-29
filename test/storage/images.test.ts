import { describe, it, expect, afterAll } from 'vitest'
import { rmSync, mkdirSync, existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import sharp from 'sharp'
import { saveImage, saveImageFromBase64, imageToBase64, imageToBase64Compressed, imageToBase64SquarePadded, deleteImage, compressImage, resolveImagePath, compressBuffer, cropFromUri, snapshotImageForShare, getImageMetadata } from '../../src/storage/images.js'
import { CATEGORIES, CATEGORY_KEYS, isValidCategory, isValidSubcategory, categoryForSubcategory } from '../../src/constants/categories.js'
import { COLORS, isValidColor, normalizeColor } from '../../src/constants/colors.js'

const TEST_DIR = process.env.CLOSET_DATA_DIR!
const U = 'self'

async function makeTempJpeg(width = 100, height = 100): Promise<string> {
  const path = join(TEST_DIR, `_tmp_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`)
  mkdirSync(TEST_DIR, { recursive: true })
  await sharp({
    create: { width, height, channels: 3, background: { r: 100, g: 150, b: 200 } },
  })
    .jpeg()
    .toFile(path)
  return path
}

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

// ─── saveImage ────────────────────────────────────────────────────────────────

describe('saveImage', () => {
  it('saves a file and returns a relative path', async () => {
    const src = await makeTempJpeg()
    const rel = await saveImage(src, 'items', U)
    expect(rel).toMatch(/^images\/items\/.+\.jpg$/)
    expect(existsSync(resolveImagePath(rel, U))).toBe(true)
  })

  it('compresses a large image to within 1200px', async () => {
    const src = await makeTempJpeg(2400, 2400)
    const rel = await saveImage(src, 'items', U)
    const meta = await sharp(resolveImagePath(rel, U)).metadata()
    expect(meta.width).toBeLessThanOrEqual(1200)
    expect(meta.height).toBeLessThanOrEqual(1200)
  })

  it('does not upscale a small image', async () => {
    const src = await makeTempJpeg(50, 50)
    const rel = await saveImage(src, 'items', U)
    const meta = await sharp(resolveImagePath(rel, U)).metadata()
    expect(meta.width).toBeLessThanOrEqual(50)
    expect(meta.height).toBeLessThanOrEqual(50)
  })
})

// ─── saveImageFromBase64 ──────────────────────────────────────────────────────

describe('saveImageFromBase64', () => {
  it('saves a base64 image and returns a relative path', async () => {
    const src = await makeTempJpeg()
    const buf = await readFile(src)
    const b64 = buf.toString('base64')
    const rel = await saveImageFromBase64(b64, 'user', U)
    expect(rel).toMatch(/^images\/user\/.+\.jpg$/)
    expect(existsSync(resolveImagePath(rel, U))).toBe(true)
  })
})

// ─── imageToBase64 ────────────────────────────────────────────────────────────

describe('imageToBase64', () => {
  it('reads a saved image back as base64', async () => {
    const src = await makeTempJpeg()
    const rel = await saveImage(src, 'items', U)
    const b64 = await imageToBase64(rel, U)
    expect(typeof b64).toBe('string')
    expect(b64.length).toBeGreaterThan(0)
    expect(b64).toMatch(/^[A-Za-z0-9+/]+=*$/)
  })
})

// ─── deleteImage ──────────────────────────────────────────────────────────────

describe('deleteImage', () => {
  it('deletes an existing image', async () => {
    const src = await makeTempJpeg()
    const rel = await saveImage(src, 'items', U)
    expect(existsSync(resolveImagePath(rel, U))).toBe(true)
    await deleteImage(rel, U)
    expect(existsSync(resolveImagePath(rel, U))).toBe(false)
  })

  it('does not throw if file does not exist', async () => {
    await expect(deleteImage('images/items/nonexistent.jpg', U)).resolves.not.toThrow()
  })
})

// ─── compressImage ────────────────────────────────────────────────────────────

describe('compressImage', () => {
  it('overwrites with a compressed version keeping dimensions ≤ 1200px', async () => {
    const src = await makeTempJpeg(2000, 2000)
    const rel = await saveImage(src, 'items', U)
    // Write back a large uncompressed version
    await sharp({
      create: { width: 2000, height: 2000, channels: 3, background: { r: 200, g: 100, b: 50 } },
    }).jpeg({ quality: 100 }).toFile(resolveImagePath(rel, U))

    await compressImage(rel, U)

    const meta = await sharp(resolveImagePath(rel, U)).metadata()
    expect(meta.width).toBeLessThanOrEqual(1200)
  })
})

// ─── imageToBase64Compressed ──────────────────────────────────────────────────

describe('imageToBase64Compressed', () => {
  it('returns a smaller base64 string than full-res for the same image', async () => {
    const src = await makeTempJpeg(2400, 2400)
    const rel = await saveImage(src, 'items', U)
    const fullB64 = await imageToBase64(rel, U)
    const compressedB64 = await imageToBase64Compressed(rel, U)
    expect(typeof compressedB64).toBe('string')
    expect(compressedB64.length).toBeGreaterThan(0)
    expect(compressedB64).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(compressedB64.length).toBeLessThan(fullB64.length)
  })

  it('does not mutate the file on disk', async () => {
    const src = await makeTempJpeg(2000, 2000)
    const rel = await saveImage(src, 'items', U)
    const metaBefore = await sharp(resolveImagePath(rel, U)).metadata()
    await imageToBase64Compressed(rel, U)
    const metaAfter = await sharp(resolveImagePath(rel, U)).metadata()
    expect(metaAfter.width).toBe(metaBefore.width)
    expect(metaAfter.height).toBe(metaBefore.height)
  })

  it('accepts custom maxDim and quality', async () => {
    const src = await makeTempJpeg(1200, 1200)
    const rel = await saveImage(src, 'items', U)
    const tight = await imageToBase64Compressed(rel, U, { maxDim: 100, quality: 20 })
    const loose = await imageToBase64Compressed(rel, U, { maxDim: 1200, quality: 100 })
    expect(tight.length).toBeLessThan(loose.length)
  })
})

// ─── imageToBase64SquarePadded ─────────────────────────────────────────────────

describe('imageToBase64SquarePadded', () => {
  it('pads a landscape image to square and returns base64', async () => {
    const src = await makeTempJpeg(400, 300)
    const rel = await saveImage(src, 'items', U)
    const b64 = await imageToBase64SquarePadded(rel, U)
    expect(typeof b64).toBe('string')
    expect(b64).toMatch(/^[A-Za-z0-9+/]+=*$/)

    const decoded = await sharp(Buffer.from(b64, 'base64')).metadata()
    expect(decoded.width).toBe(decoded.height)
    expect(decoded.width!).toBeLessThanOrEqual(1024)
  })

  it('pads a portrait image to square and returns base64', async () => {
    const src = await makeTempJpeg(300, 500)
    const rel = await saveImage(src, 'items', U)
    const b64 = await imageToBase64SquarePadded(rel, U)

    const decoded = await sharp(Buffer.from(b64, 'base64')).metadata()
    expect(decoded.width).toBe(decoded.height)
    expect(decoded.width!).toBeLessThanOrEqual(1024)
  })

  it('handles an already-square image without upscaling', async () => {
    const src = await makeTempJpeg(512, 512)
    const rel = await saveImage(src, 'items', U)
    const b64 = await imageToBase64SquarePadded(rel, U)

    const decoded = await sharp(Buffer.from(b64, 'base64')).metadata()
    expect(decoded.width).toBe(decoded.height)
    expect(decoded.width).toBe(512)
  })

  it('downscales a large square image to 1024', async () => {
    const src = await makeTempJpeg(2000, 2000)
    const rel = await saveImage(src, 'items', U)
    const b64 = await imageToBase64SquarePadded(rel, U)

    const decoded = await sharp(Buffer.from(b64, 'base64')).metadata()
    expect(decoded.width).toBe(1024)
    expect(decoded.height).toBe(1024)
  })
})

// ─── categories ───────────────────────────────────────────────────────────────

describe('categories', () => {
  it('has all expected top-level categories', () => {
    const expected = ['tops', 'bottoms', 'dresses', 'outerwear', 'shoes', 'accessories', 'activewear', 'underwear']
    for (const cat of expected) {
      expect(CATEGORY_KEYS).toContain(cat)
    }
  })

  it('validates known and unknown categories', () => {
    expect(isValidCategory('tops')).toBe(true)
    expect(isValidCategory('rockets')).toBe(false)
  })

  it('validates subcategories within their category', () => {
    expect(isValidSubcategory('tops', 't-shirt')).toBe(true)
    expect(isValidSubcategory('tops', 'jeans')).toBe(false)
  })

  it('finds parent category for a subcategory', () => {
    expect(categoryForSubcategory('sneakers')).toBe('shoes')
    expect(categoryForSubcategory('jeans')).toBe('bottoms')
    expect(categoryForSubcategory('unknown')).toBeNull()
  })
})

// ─── colors ───────────────────────────────────────────────────────────────────

describe('colors', () => {
  it('has a meaningful set of colors', () => {
    expect(COLORS.length).toBeGreaterThan(20)
  })

  it('validates known colors', () => {
    expect(isValidColor('black')).toBe(true)
    expect(isValidColor('navy')).toBe(true)
    expect(isValidColor('fuchsia-sparkle')).toBe(false)
  })

  it('normalizes qualified color strings', () => {
    expect(normalizeColor('dark navy')).toBe('navy')
    expect(normalizeColor('light blue')).toBe('light blue')
    expect(normalizeColor('bright green')).toBe('green')
  })
})

// ─── compressBuffer ──────────────────────────────────────────────────────────

describe('compressBuffer', () => {
  it('compresses a buffer to within default maxDim (1200px)', async () => {
    const src = await makeTempJpeg(2400, 2400)
    const buf = await readFile(src)
    const compressed = await compressBuffer(buf)
    const meta = await sharp(compressed).metadata()
    expect(meta.width).toBeLessThanOrEqual(1200)
    expect(meta.height).toBeLessThanOrEqual(1200)
  })

  it('accepts custom maxDim and quality', async () => {
    const src = await makeTempJpeg(1200, 1200)
    const buf = await readFile(src)
    const tight = await compressBuffer(buf, { maxDim: 100, quality: 20 })
    const loose = await compressBuffer(buf, { maxDim: 1200, quality: 100 })
    expect(tight.length).toBeLessThan(loose.length)
  })
})

// ─── cropFromUri ─────────────────────────────────────────────────────────────

describe('cropFromUri', () => {
  it('crops an image from a URI and returns a new URI', async () => {
    const src = await makeTempJpeg(1000, 1000)
    const rel = await saveImage(src, 'source', U)
    const result = await cropFromUri(rel, U, { left: 100, top: 100, width: 500, height: 500 }, 'items')
    expect(result.uri).toMatch(/^images\/items\/.+\.jpg$/)
    expect(existsSync(resolveImagePath(result.uri, U))).toBe(true)
    expect(result.buffer).toBeInstanceOf(Buffer)
    expect(result.buffer.length).toBeGreaterThan(0)
  })

  it('resizes the crop to fit within 800x1000', async () => {
    const src = await makeTempJpeg(2000, 2000)
    const rel = await saveImage(src, 'source', U)
    const result = await cropFromUri(rel, U, { left: 0, top: 0, width: 1500, height: 1500 }, 'items')
    const meta = await sharp(result.buffer).metadata()
    expect(meta.width).toBeLessThanOrEqual(800)
    expect(meta.height).toBeLessThanOrEqual(1000)
  })
})

// ─── resolveImagePath tenant containment ─────────────────────────────────────

describe('resolveImagePath tenant containment', () => {
  const A = 'user_iso_a'
  const B = 'user_iso_b'

  async function saveFor(userId: string): Promise<string> {
    return saveImage(await makeTempJpeg(), 'items', userId)
  }

  it('resolves a user\'s own image inside their tree', async () => {
    const rel = await saveFor(A)
    expect(resolveImagePath(rel, A)).toContain(join('users', A, 'images', 'items'))
  })

  it('rejects ../ traversal into another user\'s tree', async () => {
    const rel = await saveFor(B)
    const attack = `../${B}/${rel}`
    expect(() => resolveImagePath(attack, A)).toThrow(/outside user storage/)
    await expect(imageToBase64(attack, A)).rejects.toThrow()
    await expect(imageToBase64Compressed(attack, A)).rejects.toThrow()
    await expect(getImageMetadata(attack, A)).rejects.toThrow()
    await expect(cropFromUri(attack, A, { left: 0, top: 0, width: 10, height: 10 }, 'items')).rejects.toThrow()
  })

  it('does not fall back to the data root for non-self users', async () => {
    const rel = await saveFor(B)
    // Existed via the old DATA_DIR fallback: images/../users/<B>/images/...
    const attack = `images/../users/${B}/${rel}`
    expect(() => resolveImagePath(attack, A)).toThrow(/outside user storage/)
    // A missing own file resolves inside A's tree, never the legacy root.
    expect(resolveImagePath('images/items/missing.jpg', A)).toContain(join('users', A, 'images'))
  })

  it('rejects absolute paths and paths outside images/', () => {
    expect(() => resolveImagePath('/etc/passwd', A)).toThrow()
    expect(() => resolveImagePath('../../closet.db', A)).toThrow()
    expect(() => resolveImagePath('closet.db', A)).toThrow()
  })

  it('rejects missing or unsafe userIds', () => {
    expect(() => resolveImagePath('images/items/x.jpg', '')).toThrow(/unsafe userId/)
    expect(() => resolveImagePath('images/items/x.jpg', undefined as unknown as string)).toThrow(/unsafe userId/)
    expect(() => resolveImagePath('images/items/x.jpg', '../self')).toThrow(/unsafe userId/)
  })

  it('self may read the legacy root images/ tree but not escape it', () => {
    expect(resolveImagePath('images/items/legacy.jpg', 'self')).toBe(join(TEST_DIR, 'images', 'items', 'legacy.jpg'))
    expect(() => resolveImagePath(`images/../users/${B}/images/items/x.jpg`, 'self')).toThrow()
  })

  it('snapshotImageForShare cannot copy another user\'s image', async () => {
    const rel = await saveFor(B)
    await expect(snapshotImageForShare(`../${B}/${rel}`, 'payload1', A)).rejects.toThrow()
    expect(existsSync(join(TEST_DIR, 'users', A, 'images', 'share', 'payload1'))).toBe(false)
  })

  it('deleteImage cannot delete another user\'s image', async () => {
    const rel = await saveFor(B)
    await expect(deleteImage(`../${B}/${rel}`, A)).rejects.toThrow()
    expect(existsSync(resolveImagePath(rel, B))).toBe(true)
  })
})
