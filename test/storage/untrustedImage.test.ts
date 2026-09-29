import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { crc32 } from 'zlib'
import { MAX_INPUT_PIXELS, UnsupportedImageError, compressBuffer, untrustedImage } from '../../src/storage/images.js'

// OSS audit 2026-09-28 — uploads are checked from the header before decoding:
// photo formats only, and a pixel cap far below sharp's ~268 MP default.

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0)
  return Buffer.concat([len, td, crc])
}

/** A few-hundred-byte PNG whose header claims width × height pixels. */
function pngClaiming(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2 // 8-bit RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))])
}

describe('untrustedImage', () => {
  it('a normal JPEG passes and still compresses', async () => {
    const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#335' } }).jpeg().toBuffer()
    const out = await compressBuffer(jpeg)
    expect((await sharp(out).metadata()).format).toBe('jpeg')
  })

  it('refuses a small file whose header declares a huge image, before decoding', async () => {
    const bomb = pngClaiming(20_000, 20_000)
    expect(bomb.length).toBeLessThan(200)
    expect(20_000 * 20_000).toBeGreaterThan(MAX_INPUT_PIXELS)
    await expect(untrustedImage(bomb)).rejects.toBeInstanceOf(UnsupportedImageError)
  })

  it('refuses SVG and TIFF', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>')
    await expect(untrustedImage(svg)).rejects.toThrow(/Unsupported image format: svg/)
    const tiff = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).tiff().toBuffer()
    await expect(untrustedImage(tiff)).rejects.toThrow(/Unsupported image format: tiff/)
  })

  it('refuses bytes that are not an image', async () => {
    await expect(compressBuffer(Buffer.from('not an image at all'))).rejects.toBeInstanceOf(UnsupportedImageError)
  })
})
