import { describe, it, expect, afterAll } from 'vitest'
import { mkdirSync, rmSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import sharp from 'sharp'
import {
  saveImage, saveImageFromBase64, saveImageSquareCrop, compressBuffer, cropSourceBox, cropFromUri,
  resolveImagePath, orientedSize,
} from '../../src/storage/images.js'

// Issue #379: camera JPEGs store pixels landscape plus EXIF Orientation 6.
// The browser shows them upright and the user draws bulk-add boxes on that
// view, so storage must auto-orient and crops must use upright coordinates.

const TEST_DIR = process.env.CLOSET_DATA_DIR!
const U = 'self'
const RED = { r: 220, g: 20, b: 20 }

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

/**
 * A photo that looks 200×300 (portrait) when displayed, with a red 80×80 block
 * in the top-left corner of that upright view, stored the way a camera does:
 * pixels rotated to 300×200 landscape and tagged Orientation 6.
 */
async function taggedCameraJpeg(): Promise<Buffer> {
  const upright = await sharp({ create: { width: 200, height: 300, channels: 3, background: '#ffffff' } })
    .composite([{
      input: await sharp({ create: { width: 80, height: 80, channels: 3, background: RED } }).png().toBuffer(),
      left: 0, top: 0,
    }])
    .png()
    .toBuffer()
  // Orientation 6 means "rotate 90° clockwise to display", so the stored
  // pixels are the upright view rotated 90° counter-clockwise.
  return sharp(upright).rotate(270).jpeg({ quality: 95 }).withMetadata({ orientation: 6 }).toBuffer()
}

async function meanColour(buf: Buffer): Promise<{ r: number; g: number; b: number }> {
  const { channels } = await sharp(buf).stats()
  return { r: channels[0].mean, g: channels[1].mean, b: channels[2].mean }
}

function expectRed(c: { r: number; g: number; b: number }) {
  expect(c.r).toBeGreaterThan(180)
  expect(c.g).toBeLessThan(70)
  expect(c.b).toBeLessThan(70)
}

async function expectUpright(buf: Buffer, width: number, height: number) {
  const meta = await sharp(buf).metadata()
  expect(meta.width).toBe(width)
  expect(meta.height).toBe(height)
  expect(meta.orientation).toBeUndefined()
}

describe('EXIF orientation (#379)', () => {
  it('the fixture really is sideways with an orientation tag', async () => {
    const tagged = await taggedCameraJpeg()
    const meta = await sharp(tagged).metadata()
    expect([meta.width, meta.height, meta.orientation]).toEqual([300, 200, 6])
    expect(orientedSize(meta)).toEqual({ width: 200, height: 300 })
    // Raw top-left pixel of the stored landscape pixels is white, not red.
    const rawCorner = await sharp(tagged).extract({ left: 0, top: 0, width: 20, height: 20 }).toBuffer()
    expect((await meanColour(rawCorner)).r).toBeGreaterThan(200)
    expect((await meanColour(rawCorner)).g).toBeGreaterThan(200)
  })

  it('compressBuffer outputs the upright image with no tag', async () => {
    await expectUpright(await compressBuffer(await taggedCameraJpeg()), 200, 300)
  })

  it('saveImageFromBase64 stores the upright image with no tag', async () => {
    const rel = await saveImageFromBase64((await taggedCameraJpeg()).toString('base64'), 'source', U)
    await expectUpright(await sharp(resolveImagePath(rel, U)).toBuffer(), 200, 300)
  })

  it('saveImage stores the upright image with no tag', async () => {
    mkdirSync(TEST_DIR, { recursive: true })
    const src = join(TEST_DIR, `_tagged_${Date.now()}.jpg`)
    await writeFile(src, await taggedCameraJpeg())
    const rel = await saveImage(src, 'items', U)
    await expectUpright(await sharp(resolveImagePath(rel, U)).toBuffer(), 200, 300)
  })

  it('saveImageSquareCrop orients before cropping', async () => {
    const rel = await saveImageSquareCrop((await taggedCameraJpeg()).toString('base64'), 'user', U, 100)
    const out = await sharp(resolveImagePath(rel, U)).toBuffer()
    await expectUpright(out, 100, 100)
    // Upright 200×300 cover-cropped to a centred square keeps rows 50..250;
    // the red block (rows 0..80) survives only at the top-left.
    const corner = await sharp(out).extract({ left: 0, top: 0, width: 10, height: 10 }).toBuffer()
    expectRed(await meanColour(corner))
  })

  it('a box drawn on the upright view crops the block the user drew around (save → cropSourceBox)', async () => {
    const rel = await saveImageFromBase64((await taggedCameraJpeg()).toString('base64'), 'source', U)
    // Upright block covers x 0..40%, y 0..26.7%; draw inside it.
    const jpeg = await cropSourceBox(rel, U, { x: 2, y: 2, w: 30, h: 20 })
    expectRed(await meanColour(jpeg))
    // The mirror box on the other side of the photo is white.
    const other = await cropSourceBox(rel, U, { x: 68, y: 78, w: 30, h: 20 })
    expect((await meanColour(other)).g).toBeGreaterThan(200)
  })

  it('cropSourceBox is robust to a stored source that still carries the tag', async () => {
    const rel = 'images/source/_legacy_tagged.jpg'
    const abs = resolveImagePath(rel, U)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, await taggedCameraJpeg())
    const jpeg = await cropSourceBox(rel, U, { x: 2, y: 2, w: 30, h: 20 })
    expectRed(await meanColour(jpeg))
    const meta = await sharp(jpeg).metadata()
    expect(meta.orientation).toBeUndefined()
    // 30% × 200 wide, 20% × 300 tall — upright proportions.
    expect([meta.width, meta.height]).toEqual([60, 60])
  })

  it('cropFromUri uses upright pixel coordinates on a tagged source', async () => {
    const rel = 'images/source/_legacy_tagged2.jpg'
    const abs = resolveImagePath(rel, U)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, await taggedCameraJpeg())
    const { buffer } = await cropFromUri(rel, U, { left: 5, top: 5, width: 60, height: 60 }, 'items')
    expectRed(await meanColour(buffer))
  })
})
