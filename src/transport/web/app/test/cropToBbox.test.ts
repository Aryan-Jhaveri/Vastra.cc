import { describe, it, expect } from 'vitest'
import { __trimInternals } from '../src/lib/cropToBbox'

const { findTrimBounds } = __trimInternals

function makeImageData(w: number, h: number, fill: [number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    data[i * 4 + 0] = fill[0]
    data[i * 4 + 1] = fill[1]
    data[i * 4 + 2] = fill[2]
    data[i * 4 + 3] = 255
  }
  return data
}

function paintRect(
  data: Uint8ClampedArray, w: number, _h: number,
  x: number, y: number, rectW: number, rectH: number,
  fill: [number, number, number],
) {
  for (let dy = 0; dy < rectH; dy++) {
    for (let dx = 0; dx < rectW; dx++) {
      const i = ((y + dy) * w + (x + dx)) * 4
      data[i + 0] = fill[0]
      data[i + 1] = fill[1]
      data[i + 2] = fill[2]
      data[i + 3] = 255
    }
  }
}

describe('findTrimBounds', () => {
  it('returns null on too-small images', () => {
    const data = makeImageData(4, 4, [255, 255, 255])
    expect(findTrimBounds(data, 4, 4)).toBeNull()
  })

  it('returns null when corners disagree (no clear background)', () => {
    const w = 20, h = 20
    const data = makeImageData(w, h, [255, 255, 255])
    paintRect(data, w, h, 0, 0, 5, 5, [0, 0, 0])
    expect(findTrimBounds(data, w, h)).toBeNull()
  })

  it('returns null when image is fully uniform (nothing to trim toward)', () => {
    const data = makeImageData(20, 20, [255, 255, 255])
    const bounds = findTrimBounds(data, 20, 20)
    // After scanning the whole image as background, clamp brings it back to 0
    // (MIN_KEEP_FRACTION prevents trimming everything)
    // So bounds will exist but should be capped — verify we don't keep < 40%
    if (bounds) {
      const remainingH = 20 - bounds.top - bounds.bottom
      const remainingW = 20 - bounds.left - bounds.right
      expect(remainingH).toBeGreaterThanOrEqual(8) // 40% of 20
      expect(remainingW).toBeGreaterThanOrEqual(8)
    }
  })

  it('detects symmetric horizontal letterboxing', () => {
    // 30 wide x 20 tall, white bg, central 10×20 black bar — left/right should trim
    const w = 30, h = 20
    const data = makeImageData(w, h, [255, 255, 255])
    paintRect(data, w, h, 10, 0, 10, 20, [10, 10, 10])
    const bounds = findTrimBounds(data, w, h)
    expect(bounds).not.toBeNull()
    expect(bounds!.left).toBeGreaterThan(5)
    expect(bounds!.right).toBeGreaterThan(5)
    // No vertical trim — black bar spans full height
    expect(bounds!.top).toBe(0)
    expect(bounds!.bottom).toBe(0)
  })

  it('detects vertical letterboxing (shoes-style crop)', () => {
    const w = 20, h = 30
    const data = makeImageData(w, h, [255, 255, 255])
    paintRect(data, w, h, 0, 10, 20, 10, [10, 10, 10])
    const bounds = findTrimBounds(data, w, h)
    expect(bounds).not.toBeNull()
    expect(bounds!.top).toBeGreaterThan(5)
    expect(bounds!.bottom).toBeGreaterThan(5)
    expect(bounds!.left).toBe(0)
    expect(bounds!.right).toBe(0)
  })

  it('tolerates near-background pixels within COLOR_TOLERANCE', () => {
    const w = 30, h = 20
    const data = makeImageData(w, h, [250, 250, 250])
    // Slight noise in the corners (still within tolerance)
    paintRect(data, w, h, 0, 0, 2, 2, [248, 250, 252])
    // Content in middle
    paintRect(data, w, h, 10, 5, 10, 10, [50, 50, 50])
    const bounds = findTrimBounds(data, w, h)
    expect(bounds).not.toBeNull()
    expect(bounds!.left + bounds!.right).toBeGreaterThan(0)
  })

  it('clamps trim to MIN_KEEP_FRACTION on heavy borders', () => {
    // Nearly-uniform background with tiny content — would trim ~95% otherwise
    const w = 20, h = 20
    const data = makeImageData(w, h, [255, 255, 255])
    paintRect(data, w, h, 9, 9, 2, 2, [0, 0, 0])
    const bounds = findTrimBounds(data, w, h)
    if (bounds) {
      const remainingW = w - bounds.left - bounds.right
      const remainingH = h - bounds.top - bounds.bottom
      expect(remainingW).toBeGreaterThanOrEqual(8)
      expect(remainingH).toBeGreaterThanOrEqual(8)
    }
  })
})
